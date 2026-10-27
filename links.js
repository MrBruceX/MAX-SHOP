// TikTok section: one card per link in the "tiktok" list in config.js.
// Each post is embedded straight away with TikTok's own player, scaled to fit its card.
(() => {
  "use strict";

  const C = window.CONFIG || {};
  const section = document.getElementById("tiktok");
  const grid = document.getElementById("tiktokGrid");
  const title = document.getElementById("tiktokTitle");
  if (!section || !grid || !title) return;

  // TikTok's embed is drawn at this size; we scale it down to fit the card
  const BASE_W = 325;
  const BASE_H = 730;

  // Keep only real TikTok links, and drop duplicates
  const normalize = (u) => {
    let s = String(u || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const x = new URL(s);
      return /(^|\.)tiktok\.com$/i.test(x.hostname) ? x.href : "";
    } catch {
      return "";
    }
  };

  // Read the handle, post type and post id straight from the link
  const parse = (url) => {
    const m = url.match(/tiktok\.com\/@([^/?#]+)\/(video|photo)\/(\d+)/i);
    if (!m) return null;
    return { handle: decodeURIComponent(m[1]), kind: m[2].toLowerCase(), id: m[3] };
  };

  const items = [...new Set((C.tiktok?.links || []).map(normalize).filter(Boolean))];
  if (!items.length) return;

  title.textContent = C.tiktok?.title || "TikTok";
  section.hidden = false;
  grid.innerHTML = "";

  const cards = items.map((url) => buildCard(url));
  cards.forEach((c) => grid.appendChild(c.card));

  // Resize every embed to its card's width
  const fitAll = () => cards.forEach((c) => c.fit());
  if ("ResizeObserver" in window) {
    new ResizeObserver(fitAll).observe(grid);
  } else {
    addEventListener("resize", fitAll);
  }
  fitAll();

  function buildCard(url) {
    const info = parse(url);
    const card = document.createElement("article");
    card.className = "tt-card";

    // Media: the post itself, playing inside the page
    const media = document.createElement("div");
    media.className = "tt-media";
    let fit = () => {};

    if (info) {
      const frame = document.createElement("iframe");
      frame.src = `https://www.tiktok.com/embed/v2/${info.id}`;
      frame.title = `TikTok post by @${info.handle}`;
      frame.loading = "eager";
      frame.addEventListener("load", () => media.classList.add("loaded"));
      frame.allow = "fullscreen; encrypted-media";
      frame.allowFullscreen = true;
      frame.style.width = BASE_W + "px";
      frame.style.height = BASE_H + "px";
      frame.style.inset = "0 auto auto 0";
      frame.style.transformOrigin = "top left";
      media.appendChild(frame);

      fit = () => {
        const s = media.clientWidth / BASE_W;
        if (!s) return;
        media.style.aspectRatio = "auto";
        media.style.height = BASE_H * s + "px";
        frame.style.transform = `scale(${s})`;
      };
    } else {
      // Not a recognised post link: show a plain link instead of an empty box
      const link = document.createElement("a");
      link.className = "tt-fallback";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open on TikTok";
      media.appendChild(link);
    }

    // Meta: creator and post type, linking to the creator's profile
    const meta = document.createElement("div");
    meta.className = "tt-meta";
    const author = document.createElement("a");
    author.className = "tt-author";
    author.target = "_blank";
    author.rel = "noopener noreferrer";
    author.href = info ? `https://www.tiktok.com/@${encodeURIComponent(info.handle)}` : url;
    author.textContent = info ? `@${info.handle}` : "TikTok";
    const kind = document.createElement("span");
    kind.className = "tt-kind";
    kind.textContent = info ? info.kind : "";
    meta.append(author, kind);

    card.append(media, meta);
    return { card, fit };
  }
})();