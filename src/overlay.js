/**
 * Lightweight feedback overlay injected into every controlled page (context.addInitScript).
 * Exposes window.__vb = { highlight, toast, candidates, clearCandidates }.
 * Self-contained: runs in the page, no closures over Node scope.
 */
export function installOverlay() {
  if (window.__vb) return;
  const Z = 2147483000;
  const css = `
    .__vb-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#f9fafb;
      font:600 15px/1.3 -apple-system,Segoe UI,Inter,sans-serif;padding:10px 16px;border-radius:10px;
      box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:${Z};opacity:0;transition:opacity .15s;pointer-events:none;max-width:70vw}
    .__vb-toast.__vb-show{opacity:1}
    .__vb-hl{position:absolute;border:3px solid #f59e0b;border-radius:6px;box-shadow:0 0 0 4px rgba(245,158,11,.25),0 0 24px rgba(245,158,11,.6);
      z-index:${Z};pointer-events:none;transition:opacity .3s}
    .__vb-badge{position:absolute;background:#2563eb;color:#fff;font:700 14px/1 -apple-system,Segoe UI,Inter,sans-serif;
      padding:5px 8px;border-radius:999px;z-index:${Z};pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4);
      border:2px solid #fff}
    .__vb-cand{position:absolute;border:2px dashed #2563eb;border-radius:6px;z-index:${Z};pointer-events:none;
      background:rgba(37,99,235,.08)}
    .__vb-cursor{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;z-index:${Z};
      pointer-events:none;will-change:transform}
    .__vb-cursor::before{content:"";position:absolute;inset:0;border-radius:50%;background:rgba(245,158,11,.35);
      border:1.5px solid #f59e0b;box-shadow:0 0 0 1px rgba(0,0,0,.30),0 0 8px rgba(245,158,11,.75);transition:transform .12s,background .12s}
    .__vb-cursor::after{content:"";position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;
      border-radius:50%;background:#fde68a}
    .__vb-cursor.__vb-cursor-down::before{background:rgba(239,68,68,.55);border-color:#ef4444;
      box-shadow:0 0 0 2px rgba(239,68,68,.3),0 0 14px rgba(239,68,68,1);transform:scale(1.3)}
    .__vb-cursor.__vb-cursor-hide{display:none}
  `;
  const ensureStyle = () => {
    if (document.getElementById("__vb-style")) return;
    const s = document.createElement("style");
    s.id = "__vb-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  const byId = (id) => document.querySelector(`[data-vb-id="${id}"]`);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height };
  };

  let toastEl = null;
  let toastTimer = null;
  let cursorEl = null;

  const api = {
    /**
     * Draw a visible cursor at a viewport point. Playwright moves a real mouse and fires real
     * DOM events, but never paints a cursor — so head/eye control looked completely dead even
     * though hovering and clicking worked. This is the dot the user actually sees.
     * @param {{x:number,y:number,visible?:boolean,down?:boolean}} p  x/y in CSS pixels
     */
    cursor({ x, y, visible = true, down = false } = {}) {
      ensureStyle();
      // A navigation replaces the document and takes the cursor with it. Re-create it here
      // rather than waiting for the next pointer frame, otherwise it vanishes for a moment
      // after every page load and looks like tracking died.
      if (!cursorEl || !cursorEl.isConnected) {
        cursorEl = document.createElement("div");
        cursorEl.className = "__vb-cursor";
        cursorEl.__vbLast = { x: 0, y: 0, visible: false, down: false };
        (document.documentElement || document.body).appendChild(cursorEl);
      }
      if (!visible) {
        cursorEl.classList.add("__vb-cursor-hide");
        cursorEl.__vbLast = { x: cursorEl.__vbLast?.x ?? 0, y: cursorEl.__vbLast?.y ?? 0, visible: false, down: Boolean(down) };
        return true;
      }
      cursorEl.classList.remove("__vb-cursor-hide");
      if (down) {
        cursorEl.classList.add("__vb-cursor-down");
        clearTimeout(cursorEl.__vbDownTimer);
        cursorEl.__vbDownTimer = setTimeout(() => {
          if (cursorEl) cursorEl.classList.remove("__vb-cursor-down");
        }, 180);
      } else if (!cursorEl.__vbDownTimer) {
        cursorEl.classList.remove("__vb-cursor-down");
      }
      cursorEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      cursorEl.__vbLast = { x: Math.round(x), y: Math.round(y), visible: true, down: Boolean(down) };
      return true;
    },

    hideCursor() {
      api.cursor({ visible: false });
    },

    toast(msg, ms = 1800) {
      ensureStyle();
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.className = "__vb-toast";
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      requestAnimationFrame(() => toastEl.classList.add("__vb-show"));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("__vb-show"), ms);
    },
    highlight(id, ms = 600) {
      ensureStyle();
      const el = byId(id);
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const b = box(el);
      const h = document.createElement("div");
      h.className = "__vb-hl";
      Object.assign(h.style, { top: b.top - 4 + "px", left: b.left - 4 + "px", width: b.width + 8 + "px", height: b.height + 8 + "px" });
      document.documentElement.appendChild(h);
      setTimeout(() => (h.style.opacity = "0"), ms);
      setTimeout(() => h.remove(), ms + 350);
      return true;
    },
    candidates(list, ms = 8000) {
      ensureStyle();
      api.clearCandidates();
      let first = true;
      for (const c of list) {
        const el = byId(c.id);
        if (!el) continue;
        if (first) {
          el.scrollIntoView({ block: "center" });
          first = false;
        }
        const b = box(el);
        const frame = document.createElement("div");
        frame.className = "__vb-cand __vb-c";
        Object.assign(frame.style, { top: b.top - 3 + "px", left: b.left - 3 + "px", width: b.width + 6 + "px", height: b.height + 6 + "px" });
        const badge = document.createElement("div");
        badge.className = "__vb-badge __vb-c";
        badge.textContent = String(c.n);
        Object.assign(badge.style, { top: Math.max(0, b.top - 14) + "px", left: Math.max(0, b.left - 14) + "px" });
        document.documentElement.appendChild(frame);
        document.documentElement.appendChild(badge);
      }
      api._candTimer = setTimeout(api.clearCandidates, ms);
    },
    clearCandidates() {
      clearTimeout(api._candTimer);
      document.querySelectorAll(".__vb-c").forEach((n) => n.remove());
    },
  };
  window.__vb = api;
  const onMove = (e) => api.cursor({ x: e.clientX, y: e.clientY });
  window.addEventListener("pointermove", onMove, { passive: true, capture: true });
  window.addEventListener("mousemove", onMove, { passive: true, capture: true });
  window.addEventListener("pointerdown", (e) => api.cursor({ x: e.clientX, y: e.clientY, down: true }), { passive: true, capture: true });
  window.addEventListener("pointerup", (e) => api.cursor({ x: e.clientX, y: e.clientY, down: false }), { passive: true, capture: true });
}
