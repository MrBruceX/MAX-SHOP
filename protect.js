// Page protection. A deterrent only: anything sent to a browser can still be inspected by a determined person
// (view-source:, another browser, curl, JavaScript turned off). Real secrets, like the bot token, stay on the
// server in proj.env / .env and are never sent to the page. Settings are in config.js under "protection".
(() => {
  const cfg = (typeof CONFIG !== "undefined" && CONFIG.protection) || {};
  if (cfg.enabled === false) return;

  // Off on your own computer so you can still build and debug. Set runOnLocalhost: true to test it.
  const host = location.hostname;
  const isLocal = location.protocol === "file:" || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
  if (isLocal && !cfg.runOnLocalhost) return;

  const on = (key) => cfg[key] !== false;
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };

  // Keep the real console methods for the detector, then optionally silence the page's own logging.
  const realDebug = console.debug.bind(console);
  if (on("consoleWarning")) {
    console.log("%cStop!", "color:#f23f43;font:700 42px sans-serif");
    console.log("%cThis browser feature is for developers. Do not paste anything here: it can give someone else access to your account.", "font:14px sans-serif");
  }
  if (on("silenceConsole")) {
    ["log", "info", "warn", "error", "debug", "table", "dir", "trace"].forEach((m) => { console[m] = () => {}; });
  }

  // 1) Don't let other sites put this page inside a frame (clickjacking)
  if (on("blockFraming") && window.top !== window.self) {
    try { window.top.location.href = location.href; } catch (_) { document.documentElement.innerHTML = ""; }
    return;
  }

  // 2) Right-click menu
  if (on("blockRightClick")) {
    addEventListener("contextmenu", (e) => {
      if (!(e.target.closest && e.target.closest("input, textarea"))) swallow(e);
    }, true);
  }

  // 3) Shortcuts that open DevTools or view/save the source
  if (on("blockShortcuts")) {
    const devKeys = ["KeyI", "KeyJ", "KeyC", "KeyK", "KeyE", "KeyM"];
    addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (
        e.key === "F12" ||
        (ctrl && e.shiftKey && devKeys.includes(e.code)) ||
        (e.metaKey && e.altKey && ["KeyI", "KeyJ", "KeyC", "KeyU"].includes(e.code)) ||
        (ctrl && (e.code === "KeyU" || e.code === "KeyS"))
      ) swallow(e);
    }, true);
  }

  // 4) Dragging images out of the page
  if (on("blockDrag")) addEventListener("dragstart", swallow, true);

  // 5) DevTools detection. Two checks run every second:
  //    - a `debugger` statement that only pauses (and so takes time) when DevTools is open
  //    - an Error whose `stack` is read only when the DevTools console is open
  if (on("detectDevTools")) {
    let guard = null;
    let clean = 0;

    const probeDebugger = () => {
      const t = performance.now();
      debugger; // eslint-disable-line no-debugger
      return performance.now() - t > 200;
    };
    const probeConsole = () => {
      let hit = false;
      const err = new Error();
      Object.defineProperty(err, "stack", { get() { hit = true; return ""; } });
      realDebug(err);
      return hit;
    };

    const cover = () => {
      if (guard && guard.isConnected) return;
      guard = document.createElement("div");
      guard.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;" +
        "background:#000;color:#cfcfcf;font:13px 'Space Mono',monospace;letter-spacing:.2em;text-align:center;";
      guard.textContent = cfg.message || "close developer tools to continue";
      document.body.appendChild(guard);
      document.documentElement.style.overflow = "hidden";
    };
    const uncover = () => {
      if (guard) guard.remove();
      guard = null;
      document.documentElement.style.overflow = "";
    };

    const check = () => {
      let detected = false;
      try { detected = probeDebugger() || probeConsole(); } catch (_) {}
      if (detected) {
        clean = 0;
        if (cfg.onDetect === "redirect") location.replace(cfg.redirectUrl || "about:blank");
        else cover();
      } else if (guard && ++clean >= 2) {
        uncover(); // closed again: restore the page
      }
    };
    setInterval(check, 1000);
    check();
  }
})();