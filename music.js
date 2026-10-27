// Background music. Settings live in config.js ("music" and "musicVolume").
(() => {
  "use strict";

  const C = window.CONFIG || {};
  const src = String(C.music || "").trim();
  if (!src) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "musicBtn";
  btn.className = "music-btn";
  document.body.appendChild(btn);

  const audio = new Audio();
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = Math.min(1, Math.max(0, (C.musicVolume ?? 40) / 100));

  let failed = false;
  const refresh = () => {
    if (failed) btn.textContent = "Music: file not found";
    else btn.textContent = audio.paused ? "Music: off (click)" : "Music: on";
  };

  audio.addEventListener("error", () => {
    failed = true;
    refresh();
    console.warn("Music could not load:", src, "- check the file name and that it sits in the music/ folder.");
  });
  audio.addEventListener("play", refresh);
  audio.addEventListener("pause", refresh);

  audio.src = src;
  refresh();

  function play() {
    if (failed) return;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.warn("Music blocked until you interact with the page:", err);
        refresh();
      });
    }
  }

  // The button toggles play and pause.
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (audio.paused) play();
    else audio.pause();
  });

  // Browsers only allow sound after a visitor interacts with the page.
  // The first click or key press anywhere (including the entrance) starts the music.
  let started = false;
  const firstGesture = (e) => {
    if (started || e.target === btn) return;
    started = true;
    play();
  };
  document.addEventListener("pointerdown", firstGesture, { passive: true });
  document.addEventListener("keydown", firstGesture);
})();