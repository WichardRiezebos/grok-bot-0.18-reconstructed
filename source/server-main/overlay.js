(() => {
  const badge = document.createElement("div");
  badge.dataset.testid = "grok-bot-debug-overlay";
  badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#eee;border:1px solid #555;border-radius:8px;padding:8px 10px;font:12px/1.3 ui-monospace,monospace;opacity:.92";
  const paint = () => {
    const debug = window.__grokBotDebug;
    const connection = debug?.connection ?? "unknown";
    const error = debug?.lastError ? ` · ${debug.lastError}` : "";
    badge.textContent = `ws ${connection}${error}`;
  };
  paint();
  setInterval(paint, 500);
  const mount = () => { if (document.body != null && badge.parentNode == null) document.body.appendChild(badge); };
  if (document.body != null) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
