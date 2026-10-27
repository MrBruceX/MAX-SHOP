(() => {
  "use strict";

  const C = window.CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const isSet = (id) => !!id && !/^0+$/.test(String(id)) && !/PASTE/i.test(String(id));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const STATUS = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline" };
  // Animations always run on this site (the owner asked for motion). Set to true to honour the OS setting.
  const reduceMotion = false;
  // When previewing with Live Server, live Discord status comes from server.js on port 3000
  const API = /^55(00|01|03)$/.test(location.port) ? "http://127.0.0.1:3000" : "";

  // ---------- helpers ----------
  function setDot(el, status) {
    const s = STATUS[status] ? status : "offline";
    el.className = "dot " + s;
    el.title = STATUS[s];
  }
  function activityText(acts = []) {
    const custom = acts.find((a) => a.type === 4 && a.state);
    const game = acts.find((a) => a.type !== 4);
    return custom?.state || (game ? `${game.type === 0 ? "Playing" : "Doing"} ${game.name}` : "");
  }
  function defaultAvatar(id) {
    try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`; }
    catch (_) { return ""; }
  }
  const avatarOf = (u) => (u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
    : defaultAvatar(u.id));

  // Staff IDs must be real Discord IDs (17 to 20 digits). Placeholders are skipped.
  const staffList = () => (C.staff || [])
    .map((s) => (typeof s === "string" ? { discordUserId: s } : s))
    .filter((s) => s && /^\d{17,20}$/.test(String(s.discordUserId)));

  // ---------- starfield ----------
  function startStars() {
    const canvas = $("sky");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let stars = [];

    const paint = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.fillStyle = "#ffffff";
      for (const s of stars) {
        ctx.globalAlpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(s.t));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(180, Math.floor((innerWidth * innerHeight) / 8000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        r: Math.random() * 1.2 + 0.3,
        vy: 0.25 + Math.random() * 0.45,
        vx: (Math.random() - 0.5) * 0.3,
        t: Math.random() * Math.PI * 2,
      }));
      paint();
    };

    const tick = () => {
      for (const s of stars) {
        s.y -= s.vy;
        s.x += s.vx;
        if (s.x < -2) s.x = innerWidth + 2;
        if (s.x > innerWidth + 2) s.x = -2;
        s.t += 0.015;
        if (s.y < -2) {
          s.y = innerHeight + 2;
          s.x = Math.random() * innerWidth;
        }
      }
      paint();
      requestAnimationFrame(tick);
    };

    addEventListener("resize", resize);
    resize();
    if (!reduceMotion) requestAnimationFrame(tick);
  }

  // ---------- scroll reveal ----------
  function setupReveal() {
    if (reduceMotion) return;
    const SEL = ".marquee, .sec, .strip, .prod, .free-row, .shot, .tt-card, .staff-card";
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });

    const mark = (el) => {
      if (el.classList.contains("reveal") || !el.matches(SEL)) return;
      el.classList.add("reveal");
      const siblings = el.parentElement ? [...el.parentElement.children] : [];
      const i = Math.max(0, siblings.indexOf(el));
      el.style.transitionDelay = Math.min(i * 70, 350) + "ms";
      io.observe(el);
    };
    document.querySelectorAll(SEL).forEach(mark);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          mark(node);
          node.querySelectorAll?.(SEL).forEach(mark);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---------- text ----------
  function renderText() {
    const name = C.shopName || "Shop";
    document.title = name;
    $("mark").textContent = C.logoText || name;
    $("eyebrow").textContent = C.eyebrow || "";
    $("eyebrow").hidden = !C.eyebrow;
    $("headline").textContent = name;
    $("lede").textContent = C.tagline || "";
    $("gateBtn").textContent = C.gateText || "Enter";
    $("gateMeta").textContent = C.gateMeta || "";
    $("heroJoin").href = C.server?.invite || "#";
    $("serverJoin").href = C.server?.invite || "#";
    $("serverName").textContent = C.server?.fallbackName || name;
    $("footText").textContent = `© ${new Date().getFullYear()} ${name}`;
    $("ownerName").textContent = C.owner?.fallbackName || name;
    $("ownerHandle").textContent = C.owner?.fallbackHandle ? "@" + C.owner.fallbackHandle : "";
    $("ownerAvatar").src = C.owner?.fallbackAvatar || "";
  }

  // ---------- products ----------
  function renderProducts() {
    const list = C.products || [];
    $("productList").innerHTML = list.length ? list.map((p) => {
      const img = p.image
        ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
        : `<span class="prod-letter">${esc((p.name || "?").trim().charAt(0))}</span>`;
      const badge = p.badge ? `<span class="tag">${esc(p.badge)}</span>` : "";
      const desc = p.description ? `<p>${esc(p.description)}</p>` : "";
      return `
        <article class="prod">
          <a class="prod-img" href="${esc(p.link)}" target="_blank" rel="noopener"
             data-name="${esc(p.name)}" aria-label="Order ${esc(p.name)}">
            ${img}${badge}
          </a>
          <div class="prod-body">
            <div class="prod-info">
              <h3>${esc(String(p.name || "").trim())}</h3>${desc}
            </div>
            <div class="prod-side">
              <span class="prod-price">${esc(p.price)}</span>
              <a class="prod-buy" href="${esc(p.link)}" target="_blank" rel="noopener">Order</a>
            </div>
          </div>
        </article>`;
    }).join("") : '<p class="empty">No products listed yet.</p>';
  }

  // ---------- free downloads ----------
  function renderFree() {
    const list = C.freeProducts || [];
    if (!list.length) return;
    $("free").hidden = false;
    $("freeNote").textContent = C.freeNote || "";
    $("freeList").innerHTML = list.map((f) => {
      const href = String(f.file || "").trim();
      const fileName = href.split("/").pop().split("?")[0] || "download";
      return `
        <article class="free-row">
          <div class="free-info">
            <h3>${esc(f.name)}${f.version ? `<span class="ver">v${esc(f.version)}</span>` : ""}</h3>
            <p>${esc(f.description)}</p>
            <p class="small muted">${esc(fileName)}</p>
          </div>
          <a class="btn-solid" href="${esc(href)}" download>Download</a>
        </article>`;
    }).join("");
  }

  // ---------- proof screenshots ----------
  function renderShots() {
    const shots = C.discordVouches || [];
    $("shotGrid").innerHTML = shots.length ? shots.map((src, i) => `
      <button class="shot" type="button" data-src="${esc(src)}" aria-label="Open screenshot ${i + 1}">
        <img src="${esc(src)}" alt="Discord screenshot ${i + 1}" loading="lazy">
        <span class="shot-missing">Missing file: ${esc(src)}</span>
      </button>`).join("") : '<p class="empty">No screenshots added yet.</p>';
  }

  // Mark missing images so you can see which file to add
  document.addEventListener("error", (e) => {
    if (e.target.tagName !== "IMG") return;
    const shot = e.target.closest(".shot");
    if (shot) shot.classList.add("missing");
    const pimg = e.target.closest(".prod-img");
    if (pimg) {
      pimg.classList.add("broken");
      e.target.remove();
    }
  }, true);

  function setupLightbox() {
    const box = $("lightbox");
    const close = () => { box.hidden = true; $("lbImg").removeAttribute("src"); };
    $("shotGrid").addEventListener("click", (e) => {
      const btn = e.target.closest(".shot");
      if (!btn || btn.classList.contains("missing")) return;
      $("lbImg").src = btn.dataset.src;
      box.hidden = false;
    });
    $("lbClose").addEventListener("click", close);
    box.addEventListener("click", (e) => { if (e.target === box) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    close();
  }

  // ---------- entrance ----------
  function setupGate(onOpen) {
    const gate = $("gate");
    let entered = false;
    try { entered = sessionStorage.getItem("maxPcEntered") === "1"; } catch (_) {}
    if (entered) {
      gate.remove();
      document.body.classList.remove("locked");
      onOpen();
      return;
    }

    let letter = 0;
    const title = String(C.gateTitle || "MAX OPTIMIZATION");
    $("gateTitle").innerHTML = title.split(/\s+/).filter(Boolean).map((word) => (
      `<span class="word">${[...word].map((ch) => (
        `<span class="ch" style="--i:${letter++}">${esc(ch)}</span>`
      )).join("")}</span>`
    )).join("");

    const bar = $("gateBar");
    const pct = $("gatePct");
    const DURATION = 1900;
    const t0 = performance.now();
    const load = (now) => {
      const p = Math.min(1, (now - t0) / DURATION);
      bar.style.width = (p * 100).toFixed(1) + "%";
      pct.textContent = Math.floor(p * 100) + "%";
      if (p < 1) requestAnimationFrame(load);
      else gate.classList.add("ready");
    };
    requestAnimationFrame(load);

    const enter = () => {
      if (!gate.classList.contains("ready") || gate.classList.contains("leaving")) return;
      gate.classList.add("leaving");
      try { sessionStorage.setItem("maxPcEntered", "1"); } catch (_) {}
      setTimeout(() => {
        gate.remove();
        document.body.classList.remove("locked");
        onOpen();
      }, 700);
    };
    $("gateBtn").addEventListener("click", enter);
    document.addEventListener("keydown", (e) => { if (e.key === "Enter" && $("gate")) enter(); });
  }

  // ---------- owner (Lanyard) ----------
  async function loadOwner() {
    const o = C.owner || {};
    if (!isSet(o.discordUserId)) {
      $("ownerActivity").textContent = "Add discordUserId in config.js to show live status.";
      return;
    }
    try {
      const res = await fetch(`https://api.lanyard.rest/v1/users/${encodeURIComponent(o.discordUserId)}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "not found");
      const { discord_user: u, discord_status: status, activities = [] } = json.data;

      $("ownerAvatar").src = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=256`
        : o.fallbackAvatar || "";
      $("ownerName").textContent = u.global_name || u.username;
      $("ownerHandle").textContent = "@" + u.username;
      setDot($("ownerDot"), status);
      $("ownerActivity").textContent = activityText(activities);
    } catch (err) {
      console.warn("Owner profile:", err);
      $("ownerActivity").textContent = "Live status unavailable. Join the Lanyard server to enable it.";
    }
  }

  // ---------- Discord server (public widget) ----------
  async function loadServer() {
    const s = C.server || {};
    if (!isSet(s.serverId)) {
      $("serverNote").textContent = "Add serverId in config.js to show live members.";
      return;
    }
    try {
      const res = await fetch(`https://discord.com/api/guilds/${encodeURIComponent(s.serverId)}/widget.json`);
      if (!res.ok) throw new Error("widget " + res.status);
      const w = await res.json();

      $("serverName").textContent = w.name || s.fallbackName;
      $("serverCount").textContent = `${w.presence_count} online now`;
      $("serverNote").textContent = "";
      if (w.instant_invite) {
        $("serverJoin").href = w.instant_invite;
        $("heroJoin").href = w.instant_invite;
      }
      const members = (w.members || []).slice(0, 40);
      $("memberList").innerHTML = members.length ? members.map((m) => `
        <li class="member" title="${esc(m.username)}">
          <span class="m-av">
            <img src="${esc(m.avatar_url)}" alt="" loading="lazy">
            <i class="dot ${esc(m.status || "online")}"></i>
          </span>
          <span class="m-name">${esc(m.nick || m.username)}</span>
        </li>`).join("") : '<li class="empty">Nobody online right now.</li>';
    } catch (err) {
      console.warn("Server widget:", err);
      $("serverNote").textContent = "Live member list needs the Server Widget turned on (Server Settings → Widget).";
    }
  }

  // ---------- staff team ----------
    // ---------- staff team (from the Discord server widget) ----------
  function renderStaff() {
    const list = staffList();
    if (!list.length) return;
    $("staff").hidden = false;
    $("navStaff").hidden = false;
    $("staffList").innerHTML = list.map((s) => `
      <li class="staff-card" data-id="${esc(s.discordUserId)}">
        <div class="st-av">
          <img alt="" src="${esc(defaultAvatar(s.discordUserId))}">
          <i class="dot offline"></i>
        </div>
        <div class="st-info">
          <h3 class="st-name">${esc(s.name || "Staff")}</h3>
          <p class="st-role">${esc(s.role || "Staff")}</p>
          <p class="st-act"></p>
        </div>
      </li>`).join("");
    loadStaff();
    setInterval(loadStaff, 30000);
  }

  async function loadStaff() {
    const serverId = C.server?.serverId;
    let widget = null;
    if (isSet(serverId)) {
      try {
        const res = await fetch(`https://discord.com/api/guilds/${encodeURIComponent(serverId)}/widget.json`);
        if (res.ok) widget = await res.json();
      } catch (_) {}
    }
    const online = new Map((widget?.members || []).map((m) => [String(m.id), m]));

    for (const staff of staffList()) {
      const card = document.querySelector(`.staff-card[data-id="${staff.discordUserId}"]`);
      if (!card) continue;
      const m = online.get(String(staff.discordUserId));
      const dot = card.querySelector(".dot");

      if (m) {
        card.querySelector("img").src = m.avatar_url;
        card.querySelector(".st-name").textContent = m.nick || m.username;
        setDot(dot, m.status || "online");
        card.querySelector(".st-act").textContent = m.game?.name ? `Playing ${m.game.name}` : "";
      } else {
        setDot(dot, "offline");
        card.querySelector(".st-act").textContent = "Offline";
      }
    }
  }

  // ---------- nav underline for the section you are reading ----------
  function setupNavSpy() {
    const links = [...document.querySelectorAll(".menu a[href^='#']")].filter((a) => !a.hidden);
    const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("active"));
        map.get(en.target.id)?.classList.add("active");
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    map.forEach((_, id) => {
      const sec = document.getElementById(id);
      if (sec && !sec.hidden) io.observe(sec);
    });
  }

  // ---------- visitor counter (once per browser session) ----------
  function countVisit() {
    if (location.protocol === "file:") return;
    try {
      if (sessionStorage.getItem("maxpc-counted")) return;
      sessionStorage.setItem("maxpc-counted", "1");
    } catch (_) {}
    fetch(API + "/api/visit", { method: "POST" }).catch(() => {});
  }

  // ---------- boot ----------
  startStars();
  renderText();
  renderProducts();
  renderFree();
  renderShots();
  renderStaff();
  setupLightbox();
  setupReveal();
  countVisit();
  setupGate(() => {});
  loadOwner();
  loadServer();
  setInterval(loadOwner, 30000);
  setInterval(loadServer, 30000);

  // links.js builds the TikTok cards after the page loads, so the nav spy runs on load
  addEventListener("load", setupNavSpy);
})();