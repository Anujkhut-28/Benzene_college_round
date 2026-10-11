/**
 * Content script: hands-free control for the page you are actually on.
 *
 * Responsibilities:
 *   - run the webcam head/hand tracker and report cursor + pinch to the server
 *   - relay voice commands from the background worker
 *   - show a small unobtrusive status chip, and the cursor the user aims with
 *
 * It talks to the background worker only. Never to the socket directly: the
 * worker owns the single connection and the reconnect logic.
 */

// The worker injects these files on demand into tabs that were already open when the
// extension was installed. Two copies in one frame would re-register every listener and
// double every click. The block gives each copy its own scope (so a re-injection is not a
// redeclaration SyntaxError) and the flag makes the second copy a no-op.
if (!globalThis.__handsFreeContentInstalled) {
globalThis.__handsFreeContentInstalled = true;

const send = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, payload }).catch(() => ({ ok: false, error: "background asleep" }));

const NAMESPACE = "handsfree";

let tracker = null;
let running = false;
let serverCursor = null;

/** Pointer clicks the user makes with a real mouse must not be sent to the server. */
let suppressPointerUntil = 0;

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function chip() {
  if (document.getElementById(`${NAMESPACE}-chip`)) return document.getElementById(`${NAMESPACE}-chip`);
  const el = document.createElement("div");
  el.id = `${NAMESPACE}-chip`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "bottom:16px",
    "left:16px",
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:8px 12px",
    "border-radius:999px",
    "background:rgba(18,18,20,0.92)",
    "color:#f5f5f7",
    "font:500 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
    "pointer-events:none",
    "transition:opacity .18s ease",
    "opacity:0",
  ].join(";");
  const dot = document.createElement("span");
  dot.style.cssText = "width:9px;height:9px;border-radius:50%;background:#8e8e93;flex:none";
  const label = document.createElement("span");
  label.textContent = "HandsFree";
  el.append(dot, label);
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function setStatus(text, tone = "idle") {
  const el = chip();
  const colors = { idle: "#8e8e93", ok: "#30d158", warn: "#ffd60a", error: "#ff453a" };
  el.firstElementChild.style.background = colors[tone] ?? colors.idle;
  el.lastElementChild.textContent = text;
  el.style.opacity = "1";
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => {
    el.style.opacity = "0";
  }, 4000);
}

// ---------------------------------------------------------------------------
// Cursor
//
// The cursor lives in the page so the user sees exactly where a click will land.
// It is pointer-events:none, so it can never intercept the page's own clicks.
// ---------------------------------------------------------------------------

function cursorEl() {
  if (serverCursor) return serverCursor;
  const el = document.createElement("div");
  el.id = `${NAMESPACE}-cursor`;
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:0",
    "top:0",
    "width:22px",
    "height:22px",
    "margin:-11px 0 0 -11px",
    "border-radius:50%",
    "background:rgba(255,159,10,0.55)",
    "border:2px solid rgba(255,159,10,0.95)",
    "box-shadow:0 0 0 1px rgba(0,0,0,0.35), 0 2px 10px rgba(0,0,0,0.35)",
    "pointer-events:none",
    "display:none",
    "will-change:transform",
    "transition:background .12s ease",
  ].join(";");
  (document.body || document.documentElement).appendChild(el);
  serverCursor = el;
  return el;
}

function moveCursor(x, y, { visible = true, pinched = false } = {}) {
  const el = cursorEl();
  el.style.display = visible ? "block" : "none";
  el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  el.style.background = pinched ? "rgba(255,69,58,0.7)" : "rgba(255,159,10,0.55)";
  el.style.borderColor = pinched ? "rgba(255,69,58,1)" : "rgba(255,159,10,0.95)";
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * HeadTracker and the MediaPipe bridge are classic scripts (MV3 content scripts cannot
 * use import/export), and are declared in manifest.json ahead of this file. Both attach
 * to globalThis. `loadTracker` just waits for them to be present.
 */
function bridge() {
  if (!globalThis.HandsFreePageBridge) {
    throw new Error("tracker failed to load (head-tracker-core.js / page-bridge.js missing)");
  }
  return globalThis.HandsFreePageBridge;
}

let sending = false;
let snapEnabled = false;

/** A completed pinch is one click, at the cursor position, after the smoothing settles. */
async function onPinch({ x, y }) {
  setStatus("pinch — click", "ok");
  await send("pointer", { x, y, snap: snapEnabled, click: true });
}

async function onFrame(state) {
  if (!state) return;
  const { x, y, pinched, faceVisible } = state;

  if (faceVisible === false) {
    // Freeze rather than fly the cursor to a corner when tracking is lost.
    setStatus("no face", "warn");
  }

  moveCursor(x, y, { visible: faceVisible !== false, pinched: Boolean(pinched) });

  if (sending) return;
  sending = true;
  // Coalesce to one message per frame: the tracker runs at camera rate and the
  // server only needs the latest position.
  requestAnimationFrame(async () => {
    sending = false;
    await send("pointer", { x, y, snap: snapEnabled });
  });
}

/** Bumped by every start()/stop() so a superseded start() can discard its result. */
let generation = 0;

async function start() {
  if (running) return { ok: true };
  const gen = ++generation;

  setStatus("starting the camera…", "warn");

  let mod;
  try {
    mod = bridge();
  } catch (err) {
    setStatus(err.message, "error");
    send("trackerError", { message: err.message });
    return { ok: false, error: err.message };
  }

  const settings = await chrome.storage.local.get(["sensitivity", "mirror", "mode", "eyeSensitivity", "clickMode"]);
  // The tracker only understands these three; anything else silently degrades to head
  // mode, so a stale or misspelled stored value must not be passed straight through.
  const MODES = ["head", "blend", "eye"];
  const mode = MODES.includes(settings.mode) ? settings.mode : "head";
  const cfg = {
    sensitivity: Number(settings.sensitivity) || 1,
    eyeSensitivity: Number(settings.eyeSensitivity) || 1,
    mirror: settings.mirror !== false,
    mode,
    clickMode: settings.clickMode === "none" ? "none" : "pinch",
  };
  snapEnabled = (await chrome.storage.local.get(["snap"])).snap === true;

  // Held locally as well as on `tracker`, so a start() that is superseded by a stop()
  // tears down *its own* tracker and never the newer one.
  const mine = mod.create(cfg);
  tracker = mine;
  mine.on("frame", onFrame);
  mine.on("pinch", onPinch);
  mine.on("status", (s) => {
    // The popup renders these, so relay them rather than only painting locally.
    send("trackerStatus", s);
    if (s.state === "error") {
      // Turn the low-level reason into something the user can act on.
      const msg = /permission|NotAllowed|NotFound/i.test(s.message || "")
        ? "Camera permission denied. Allow the camera in the address bar, then press Enable tracking again."
        : s.message ?? "tracking error";
      setStatus(msg, "error");
      // Tell the worker it failed, so the popup never shows an active feature that
      // is not actually running.
      send("trackerError", { message: msg });
    }
  });

  running = true;
  const res = await mine.start();

  // The user may have pressed Stop while the camera permission prompt was open. If so,
  // tear down the tracker we just created instead of leaving the camera running.
  if (gen !== generation) {
    mine.stop();
    if (tracker === mine) tracker = null;
    running = false;
    return { ok: false, error: "cancelled" };
  }

  if (!res?.ok) {
    running = false;
    if (tracker === mine) tracker = null;
    const error = res?.error ?? "could not start tracking";
    setStatus(error, "error");
    send("trackerError", { message: error });
    return { ok: false, error };
  }
  // "eye"/"blend" estimate gaze from iris position; say so rather than implying
  // true eye tracking, which this does not do.
  const label = cfg.mode === "head" ? "head" : `gaze (${cfg.mode})`;
  const suffix = res.hand === false ? " (pinch unavailable)" : "";
  setStatus(`tracking - ${label}${suffix}`, "ok");
  return { ok: true };
}

function stop() {
  // Invalidate any in-flight start() as well as stopping what exists now.
  generation += 1;
  running = false;
  tracker?.stop();
  tracker = null;
  if (serverCursor) serverCursor.style.display = "none";
  setStatus("tracking off", "idle");
}

function recenter() {
  if (!tracker || !running) {
    setStatus("tracking is off — start it first", "warn");
    return;
  }
  tracker.recenter();
  setStatus("re-centered, hold still", "ok");
}

// ---------------------------------------------------------------------------
// Server and worker messages
//
// A single listener on purpose: two `onMessage` registrations for the same script are
// easy to forget about, and every extra copy is another duplicate handler.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Starting tracking is the one message whose outcome the worker must know: a denied
  // camera must come back as a failure, not as a silent "delivered". Hold the channel
  // until the camera has actually started (or failed to).
  if (msg?.type === "tracking" && msg.payload?.tracking) {
    start()
      .then((r) => sendResponse?.({ ok: true, ...r }))
      .catch((err) => sendResponse?.({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // Always answer, even for messages we ignore. `chrome.tabs.sendMessage` rejects when
  // no listener responds, and the worker treats that rejection as "the content script
  // is missing" and injects a second copy. Acking keeps the single copy.
  sendResponse?.({ ok: true });
  switch (msg?.type) {
    case "status":
      if (msg.payload?.connected) setStatus("connected", "ok");
      else if (msg.payload?.error) setStatus(msg.payload.error, "error");
      else setStatus("disconnected", "warn");
      break;

    case "log":
      if (msg.payload?.level === "error") setStatus(msg.payload.msg, "error");
      break;

    case "action":
      // A real pointer click triggered by our own cursor must not be echoed back
      // as a fresh gesture, or tracking would fight the user.
      suppressPointerUntil = Date.now() + 400;
      runAction(msg.payload);
      break;

    case "pending":
      if (msg.payload) setStatus(`Pending: ${msg.payload.summary} — say "confirm"`, "warn");
      break;

    case "command":
      if (msg.payload?.name === "recenter") recenter();
      break;

    case "tracking":
      if (msg.payload?.tracking) start();
      else stop();
      break;

    case "recenter":
      recenter();
      break;

    case "configure":
      // Apply slider changes live: restarting the camera to change gain would be
      // jarring and would force a new permission prompt.
      if (tracker) tracker.configure(msg.payload || {});
      chrome.storage.local
        .get(["snap"])
        .then((s) => {
          snapEnabled = s.snap === true;
        })
        .catch(() => {});
      break;
  }
});

// Never let a stray mouse click from the user be mistaken for tracker input.
document.addEventListener(
  "pointerdown",
  () => {
    suppressPointerUntil = Date.now() + 250;
  },
  { capture: true, passive: true },
);

// ---------------------------------------------------------------------------
// Acting in this tab
//
// The server decides *what* to do but its executor drives a Playwright window.
// When the extension is in use the user is looking at THIS tab, so the same
// decision is carried out here against the real page. Without this, commands
// "succeed" against a browser the user never sees.
// ---------------------------------------------------------------------------

const ACTION_HANDLERS = {
  navigate_url: (a) => {
    if (a.url) location.assign(a.url);
  },
  go_back: () => history.back(),
  go_forward: () => history.forward(),
  reload: () => location.reload(),
  scroll_down: (a) => window.scrollBy({ top: amountPx(a.amount), behavior: "smooth" }),
  scroll_up: (a) => window.scrollBy({ top: -amountPx(a.amount), behavior: "smooth" }),
  click_element: (a) => {
    if (a.targetId) findBySnapshotId(a.targetId)?.click();
  },
  type_into_field: (a) => {
    const field = a.targetId ? findBySnapshotId(a.targetId) : document.querySelector("input, textarea");
    if (!field) return;
    field.focus();
    field.value = a.text ?? a.query ?? "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  },
  press_enter: () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  },
  open_new_tab: (a) => {
    if (a.url) window.open(a.url, "_blank");
  },
  close_tab: () => window.close(),
};

function amountPx(amount) {
  const n = Number(amount);
  // The model answers 0..2 (a little / one page / to the end).
  if (!Number.isFinite(n) || n <= 0) return Math.round(innerHeight * 0.3);
  if (n >= 2) return document.body.scrollHeight;
  return Math.round(innerHeight * 0.9);
}

/**
 * The server labels elements as e01, e02... in visual order. Re-derive the same
 * ordering here so a target id still resolves on the live page.
 */
function findBySnapshotId(id) {
  const selector = "a[href], button, input, textarea, select, [role=button], [onclick]";
  const all = [...document.querySelectorAll(selector)].filter(
    (el) => el.offsetParent !== null || el.getClientRects().length,
  );
  const match = /^e(\d+)$/i.exec(String(id || ""));
  if (!match) return all.find((el) => el.id === id) ?? null;
  const index = Number(match[1]) - 1;
  return all[index] ?? null;
}

function runAction(entry) {
  const action = entry?.action;
  if (!action?.type) return;
  const handler = ACTION_HANDLERS[action.type];
  if (!handler) return; // Tabs/submit are left to the controlled window.
  try {
    handler(action);
  } catch (err) {
    console.warn(`[HandsFree] ${action.type} failed: ${err.message}`);
  }
}

// Announce this page so the worker can re-assert its state: after a navigation the new
// copy has no tracker, and without this the popup would still claim tracking is on.
send("contentReady");
send("refreshSnapshot");
}