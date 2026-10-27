// Profile Hub server: live Discord presence + banners using your bot. No npm install needed on Node.js 22+.
//
// Setup (one time):
//   1. https://discord.com/developers/applications -> your application -> Bot:
//        - Reset Token and copy it
//        - turn ON "Presence Intent" and "Server Members Intent", then Save
//   2. Invite the bot to YOUR Discord server (the server must include everyone on your page):
//        https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=0
//        (this file prints the exact link when it starts)
//   3. Put the token in a file named  proj.env  (or  .env ) next to this file, one line:
//          DISCORD_BOT_TOKEN=paste_your_token_here      (BOT_TOKEN=... works too)
//   4. Run:   node server.js     (keep it running while the site is open)
//
// How it works: Discord only tells a bot about people who share a server with it, so everyone listed in
// config.js must be a member of a server the bot is in. Anyone who isn't falls back to Lanyard.
// Only IDs listed in config.js are served. The token stays in .env. Never put it in config.js or app.js.
// Node older than 22? Run  npm install ws  once.

const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- read .env and proj.env (simple KEY=value lines) ----
for (const file of [".env", "proj.env"]) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
}

const TOKEN = process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_URL = process.env.GATEWAY_URL || "wss://gateway.discord.gg/?v=10&encoding=json";
const TTL_MS = 60 * 1000;

// No bot token? The site still works (TikTok, music, products). Only live Discord status is turned off.
if (!TOKEN) {
  console.log("No bot token: live Discord status is off. The rest of the site still works.");
}

// ---- which IDs we serve: config.js members + featured (+ optional ALLOWED_IDS) ----
let allowedCache = { at: 0, set: new Set() };
function allowedIds() {
  if (Date.now() - allowedCache.at < 5000) return allowedCache.set;
  const ids = new Set((process.env.ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
  try {
    const code = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const cfg = vm.runInNewContext(code + "\n;window.CONFIG", { window: {} });
    [...(cfg.members || []), ...(cfg.featured || [])].forEach((m) => ids.add(String(m).trim()));
  } catch (err) {
    console.warn("Could not read config.js:", err.message);
  }
  allowedCache = { at: Date.now(), set: ids };
  return ids;
}

// ---------------- Discord REST (profile + banner), cached ----------------
const userCache = new Map();
async function getUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;
  const r = await fetch(`https://discord.com/api/v10/users/${id}`, {
    headers: { Authorization: `Bot ${TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) { const e = new Error("discord " + r.status); e.status = r.status; throw e; }
  const user = await r.json();
  userCache.set(id, { at: Date.now(), user });
  return user;
}

async function bannerFor(id) {
  const user = await getUser(id);
  const ext = user.banner && user.banner.startsWith("a_") ? "gif" : "png";
  const color = user.accent_color ?? user.banner_color ?? null;
  return {
    url: user.banner ? `https://cdn.discordapp.com/banners/${id}/${user.banner}.${ext}?size=1024` : null,
    color: typeof color === "string" ? parseInt(color.replace("#", ""), 16) : color,
  };
}

// ---------------- Discord Gateway (live presence) ----------------
const WS = globalThis.WebSocket || (() => { try { return require("ws"); } catch { return null; } })();
const INTENTS = (1 << 0) | (1 << 1) | (1 << 8); // GUILDS, GUILD_MEMBERS, GUILD_PRESENCES

const presenceById = new Map(); // id -> { status, activities }
const guildsOf = new Map();     // id -> Set(guildId) the person is a member of
const profileById = new Map();  // id -> user object seen on the gateway
const guilds = new Set();
const requested = new Map();    // guildId -> Set(id) already asked about
const gw = { state: "starting", ws: null, seq: null, hb: null, hbTimeout: null, ackd: true, backoff: 1000 };
let reportTimer = null;

function markMember(id, guildId) {
  if (!guildId) return;
  if (!guildsOf.has(id)) guildsOf.set(id, new Set());
  guildsOf.get(id).add(guildId);
}

function setPresence(id, p, guildId) {
  presenceById.set(id, { status: p.status || "offline", activities: p.activities || [] });
  markMember(id, guildId || p.guild_id);
}

function ingest(members, presences, guildId) {
  const allowed = allowedIds();
  for (const m of members || []) {
    const u = m.user;
    if (u && allowed.has(u.id)) { markMember(u.id, guildId); profileById.set(u.id, u); }
  }
  for (const p of presences || []) {
    if (p.user && allowed.has(p.user.id)) setPresence(p.user.id, p, guildId);
  }
}

function send(obj) {
  if (gw.ws && gw.ws.readyState === 1) gw.ws.send(JSON.stringify(obj));
}

function stopHeartbeat() { clearTimeout(gw.hbTimeout); clearInterval(gw.hb); }
function startHeartbeat(ms) {
  stopHeartbeat();
  gw.ackd = true;
  const beat = () => {
    if (!gw.ackd) { try { gw.ws.close(4000); } catch (_) {} return; } // no reply -> reconnect
    gw.ackd = false;
    send({ op: 1, d: gw.seq });
  };
  gw.hbTimeout = setTimeout(() => { beat(); gw.hb = setInterval(beat, ms); }, ms * Math.random());
}

function identify() {
  send({
    op: 2,
    d: { token: TOKEN, intents: INTENTS, properties: { os: process.platform, browser: "profile-hub", device: "profile-hub" } },
  });
}

// Ask Discord for the presence of the people in config.js, per server the bot is in.
function syncMembers(only) {
  if (gw.state !== "ready") return;
  const allowed = [...allowedIds()];
  for (const g of only ? [only] : guilds) {
    const done = requested.get(g) || new Set();
    requested.set(g, done);
    const todo = allowed.filter((id) => !done.has(id));
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      send({ op: 8, d: { guild_id: g, user_ids: batch, presences: true, limit: 0 } });
      batch.forEach((id) => done.add(id));
    }
  }
}
setInterval(() => syncMembers(), 60 * 1000).unref();

function report() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    const allowed = [...allowedIds()];
    const live = allowed.filter((id) => guildsOf.get(id) && guildsOf.get(id).size);
    const missing = allowed.filter((id) => !live.includes(id));
    console.log(`Live presence: ${live.length}/${allowed.length} people found in the bot's server(s).`);
    if (missing.length) {
      console.log(`  Not in any server with the bot (profile shows, but no live status until they join): ${missing.join(", ")}`);
    }
  }, 4000);
}

function dispatch(t, d) {
  switch (t) {
    case "READY": {
      gw.state = "ready";
      gw.backoff = 1000;
      guilds.clear();
      requested.clear();
      const appId = (d.application && d.application.id) || d.user.id;
      console.log(`Gateway connected as ${d.user.username}. Bot is in ${d.guilds.length} server(s).`);
      if (!d.guilds.length) {
        console.log(`The bot is not in any server yet. Invite it to your server:\n  https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=0`);
      }
      break;
    }
    case "GUILD_CREATE":
      guilds.add(d.id);
      ingest(d.members, d.presences, d.id);
      syncMembers(d.id);
      report();
      break;
    case "GUILD_DELETE":
      if (!d.unavailable) {
        guilds.delete(d.id);
        for (const set of guildsOf.values()) set.delete(d.id);
      }
      break;
    case "GUILD_MEMBERS_CHUNK":
      ingest(d.members, d.presences, d.guild_id);
      report();
      break;
    case "PRESENCE_UPDATE":
      if (d.user && allowedIds().has(d.user.id)) setPresence(d.user.id, d);
      break;
    case "GUILD_MEMBER_ADD":
      if (d.user && allowedIds().has(d.user.id)) {
        markMember(d.user.id, d.guild_id);
        profileById.set(d.user.id, d.user);
        send({ op: 8, d: { guild_id: d.guild_id, user_ids: [d.user.id], presences: true, limit: 0 } });
      }
      break;
    case "GUILD_MEMBER_UPDATE":
      if (d.user && allowedIds().has(d.user.id)) profileById.set(d.user.id, d.user);
      break;
    case "GUILD_MEMBER_REMOVE":
      if (d.user && guildsOf.has(d.user.id)) guildsOf.get(d.user.id).delete(d.guild_id);
      break;
  }
}

function connectGateway() {
  if (!TOKEN) return;
  if (!WS) {
    console.warn("Live presence is off: this Node.js has no WebSocket. Update to Node 22+, or run:  npm install ws");
    return;
  }
  gw.state = "connecting";
  gw.seq = null;
  const ws = new WS(GATEWAY_URL);
  gw.ws = ws;

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
    if (msg.s != null) gw.seq = msg.s;
    switch (msg.op) {
      case 10: startHeartbeat(msg.d.heartbeat_interval); identify(); break;
      case 11: gw.ackd = true; break;
      case 1: send({ op: 1, d: gw.seq }); break;
      case 7: try { ws.close(4000); } catch (_) {} break;
      case 9: setTimeout(identify, 1000 + Math.random() * 4000); break;
      case 0: dispatch(msg.t, msg.d); break;
    }
  };

  ws.onclose = (ev) => {
    stopHeartbeat();
    gw.state = "closed";
    const code = ev && ev.code;
    if (code === 4004) return console.error("Discord rejected the bot token. Check BOT_TOKEN in .env (use Reset Token for a fresh one).");
    if (code === 4013 || code === 4014) {
      return console.error('Discord refused the intents. In the Developer Portal -> Bot, turn ON "Presence Intent" and "Server Members Intent", save, then restart this server.');
    }
    const wait = gw.backoff;
    gw.backoff = Math.min(gw.backoff * 2, 30000);
    console.warn(`Gateway disconnected (${code || "no code"}). Reconnecting in ${Math.round(wait / 1000)}s...`);
    setTimeout(connectGateway, wait);
  };
  ws.onerror = () => {};
}

// Live status only exists for people who share a server with the bot (a Discord rule).
// Everyone else still gets their profile (name, avatar, banner) with live: false.
function presenceFor(id) {
  const memberOf = guildsOf.get(id);
  if (!memberOf || !memberOf.size) return { p: { status: "offline", activities: [] }, live: false };
  const p = presenceById.get(id) || { status: "offline", activities: [] };
  return { p, live: true };
}

async function presencePayload(id) {
  const found = presenceFor(id);
  let user = null;
  try { user = await getUser(id); } catch (_) {}
  user = user || profileById.get(id);
  if (!user) return null;

  const acts = found.p.activities || [];
  const sp = acts.find((a) => a.name === "Spotify" && a.type === 2);
  const art = sp && sp.assets && sp.assets.large_image;
  return {
    discord_status: found.p.status || "offline",
    live: found.live,
    discord_user: {
      id,
      username: user.username,
      global_name: user.global_name || null,
      avatar: user.avatar || null,
      avatar_decoration_data: user.avatar_decoration_data || null,
    },
    activities: acts.map((a) => ({
      type: a.type, name: a.name, details: a.details, state: a.state, emoji: a.emoji,
      timestamps: a.timestamps, assets: a.assets, application_id: a.application_id, url: a.url,
    })),
    listening_to_spotify: !!sp,
    spotify: sp ? {
      song: sp.details,
      artist: sp.state,
      album: sp.assets && sp.assets.large_text,
      album_art_url: art && art.startsWith("spotify:") ? "https://i.scdn.co/image/" + art.slice(8) : null,
      timestamps: sp.timestamps,
      track_id: sp.sync_id,
    } : null,
  };
}

// ---------------- TikTok (video thumbnail + author, via TikTok's public oEmbed) ----------------
function normTikTok(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const x = new URL(u);
    return /(^|\.)tiktok\.com$/i.test(x.hostname) ? x.href : "";
  } catch { return ""; }
}
let ttAllowCache = { at: 0, set: new Set() };
function allowedTikTok() {
  if (Date.now() - ttAllowCache.at < 5000) return ttAllowCache.set;
  const set = new Set();
  try {
    const code = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");
    const cfg = vm.runInNewContext(code + "\n;window.CONFIG", { window: {} });
    [].concat(cfg.tiktok || []).forEach((l) => { const n = normTikTok(l); if (n) set.add(n); });
  } catch (_) {}
  ttAllowCache = { at: Date.now(), set };
  return set;
}
const TT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.tiktok.com/",
};
const ttCache = new Map();

// Fallback for posts oEmbed can't give a cover for (photo posts, some videos): read the public page's preview image.
async function pageInfo(url) {
  const r = await fetch(url, {
    headers: { ...TT_HEADERS, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const html = await r.text();
  const decode = (t) => t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
  const meta = (prop) => {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', "i"))
      || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', "i"));
    return m ? decode(m[1]) : null;
  };
  let thumb = meta("og:image") || meta("twitter:image");
  if (!thumb) {
    const m = html.match(/"(?:originCover|cover|dynamicCover)"\s*:\s*"(https:[^"]+)"/)
      || html.match(/"imageURL"\s*:\s*\{\s*"urlList"\s*:\s*\[\s*"(https:[^"]+)"/);
    if (m) { try { thumb = JSON.parse('"' + m[1] + '"'); } catch (_) { thumb = m[1]; } }
  }
  return { thumb, finalUrl: r.url || url, title: meta("og:title") };
}

async function tiktokInfo(url) {
  const hit = ttCache.get(url);
  if (hit && Date.now() < hit.until) return hit.data;

  let j = {};
  try {
    const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), { headers: TT_HEADERS, signal: AbortSignal.timeout(10000) });
    if (r.ok) j = await r.json();
  } catch (_) {}

  let rawThumb = j.thumbnail_url || null;
  let finalUrl = url;
  if (!rawThumb) {
    try {
      const pg = await pageInfo(url);
      rawThumb = pg.thumb || null;
      finalUrl = pg.finalUrl || url;
    } catch (err) { console.warn("TikTok page lookup failed: " + err.message); }
  }

  const idMatch = String(j.html || "").match(/data-video-id="(\d+)"/);
  const fromUrl = finalUrl.match(/tiktok\.com\/@([^/?#]+)\/(video|photo)\/(\d+)/i);
  const data = {
    id: j.embed_product_id || (idMatch && idMatch[1]) || (fromUrl && fromUrl[3]) || null,
    kind: fromUrl ? fromUrl[2].toLowerCase() : "video",
    title: j.title || "",
    author: j.author_name || "",
    handle: j.author_unique_id || (fromUrl && decodeURIComponent(fromUrl[1])) || "",
    profile: j.author_url || "",
    rawThumb,
    thumbnail: rawThumb ? "/api/tiktok-img?url=" + encodeURIComponent(url) : null,
  };
  if (!data.thumbnail && !data.id && !data.handle) throw new Error("TikTok gave no information for this link");
  // good results are kept 10 minutes; incomplete ones only 1 minute so they get retried soon
  ttCache.set(url, { until: Date.now() + (rawThumb ? 10 * 60 * 1000 : 60 * 1000), data });
  return data;
}

// ---------------- Visitor counter ----------------
// Counts page views and unique visitors per day. Only a hash of each visitor's IP is saved, never the IP.
// Read the totals at  /api/stats?key=YOUR_STATS_KEY  (set STATS_KEY=... in proj.env).
const crypto = require("crypto");
const DATA_DIR = path.join(__dirname, "data");
const VISITS_FILE = path.join(DATA_DIR, "visits.json");
const STATS_KEY = process.env.STATS_KEY || "";

function readVisits() {
  try { return JSON.parse(fs.readFileSync(VISITS_FILE, "utf8")); } catch { return { total: 0, days: {} }; }
}
function recordVisit(req) {
  const v = readVisits();
  const day = new Date().toISOString().slice(0, 10);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  const who = crypto.createHash("sha256").update(ip + "|" + day + "|" + (STATS_KEY || "max-pc")).digest("hex").slice(0, 16);
  v.days = v.days || {};
  const d = v.days[day] || (v.days[day] = { views: 0, uniques: [] });
  d.views++;
  if (!d.uniques.includes(who)) d.uniques.push(who);
  v.total = (v.total || 0) + 1;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VISITS_FILE, JSON.stringify(v));
}
function statsSummary() {
  const v = readVisits();
  const today = new Date().toISOString().slice(0, 10);
  const t = (v.days || {})[today] || { views: 0, uniques: [] };
  const days = Object.keys(v.days || {}).sort();
  return {
    totalViews: v.total || 0,
    today: { views: t.views, uniqueVisitors: t.uniques.length },
    lastDays: days.slice(-30).map((d) => ({ day: d, views: v.days[d].views, uniqueVisitors: v.days[d].uniques.length })),
  };
}

// ---------------- HTTP ----------------
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

// static files: only safe file types, never .env or this file
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = ""; }
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(__dirname, rel));
  const name = path.basename(file);
  const ok = file.startsWith(__dirname + path.sep) && !file.startsWith(path.join(__dirname, "data") + path.sep) && !name.startsWith(".") && name !== "server.js" && !/\.env$/i.test(name) && TYPES[path.extname(file).toLowerCase()];
  if (!ok) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  // Browsers ask before a cross-port POST (CORS preflight)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    });
    return res.end();
  }

  if (pathname === "/api/visit" && req.method === "POST") {
    try { recordVisit(req); } catch (e) { console.warn("visit not saved:", e.message); }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/stats" && req.method === "GET") {
    if (!STATS_KEY) return sendJson(res, 403, { error: "Stats are off. Add STATS_KEY=some-secret to proj.env and restart the server." });
    const key = new URL(req.url, "http://localhost").searchParams.get("key") || "";
    if (key !== STATS_KEY) return sendJson(res, 403, { error: "Wrong key." });
    return sendJson(res, 200, statsSummary());
  }

  if (pathname === "/api/health") {
    const allowed = [...allowedIds()];
    const live = allowed.filter((id) => guildsOf.get(id) && guildsOf.get(id).size);
    return sendJson(res, 200, {
      gateway: gw.state,
      servers: guilds.size,
      found: live,
      missing: allowed.filter((id) => !live.includes(id)),
    });
  }

  if (pathname === "/api/tiktok" || pathname === "/api/tiktok-img") {
    const url = normTikTok(new URL(req.url, "http://localhost").searchParams.get("url"));
    if (!url || !allowedTikTok().has(url)) return sendJson(res, 403, { error: "not allowed" });
    try {
      const info = await tiktokInfo(url);
      if (pathname === "/api/tiktok") { const { rawThumb, ...pub } = info; return sendJson(res, 200, pub); }
      // thumbnail proxy: the server downloads the cover so the browser never hits TikTok's CDN directly
      if (!info.rawThumb) return sendJson(res, 404, { error: "no thumbnail" });
      const img = await fetch(info.rawThumb, { headers: TT_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!img.ok) throw new Error("thumb " + img.status);
      res.writeHead(200, {
        "Content-Type": img.headers.get("content-type") || "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
      });
      return res.end(Buffer.from(await img.arrayBuffer()));
    } catch (err) {
      console.warn("TikTok lookup failed for " + url + ": " + err.message);
      return sendJson(res, 502, { error: "lookup failed" });
    }
  }

  const m = pathname.match(/^\/api\/(banner|presence)\/([^/]+)$/);
  if (!m) return serveStatic(req, res, pathname);

  const [, kind, id] = m;
  if (!/^\d{17,20}$/.test(id)) return sendJson(res, 400, { error: "bad id" });
  if (!allowedIds().has(id)) return sendJson(res, 403, { error: "not allowed" });
  if (!TOKEN) return sendJson(res, 503, { success: false, error: "live status is off (no bot token)" });

  try {
    if (kind === "banner") return sendJson(res, 200, await bannerFor(id));
    if (gw.state !== "ready") return sendJson(res, 503, { success: false, error: "gateway not ready" });
    const data = await presencePayload(id);
    if (!data) return sendJson(res, 404, { success: false, error: "user not found" });
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendJson(res, err.status || 500, { success: false, error: "lookup failed" });
  }
}).listen(PORT, () => {
  console.log(`Server running. Open http://localhost:${PORT}`);
  connectGateway();
});