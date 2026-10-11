/**
 * Page bridge: adapts the shared HeadTracker to the extension content script.
 *
 * Loaded as a classic script (MV3 content scripts cannot use import/export), and paired
 * with the generated `head-tracker-core.js`.
 *
 * The camera and the MediaPipe models do NOT run here. The extension CSP forbids dynamic
 * import() in a content script, so detection runs in the offscreen document and this file
 * only does the smoothing maths on the landmarks that come back.
 */

// Content scripts share one isolated-world sandbox, so head-tracker-core.js (listed
// earlier in manifest.json) has already run by the time this file executes. Resolving it
// lazily rather than at load time means a missing or renamed core file produces a clear
// error from `create()` instead of killing this whole script at parse time.
let HeadTrackerRef = null;
function HeadTracker(...args) {
  if (!HeadTrackerRef) {
    const core = globalThis.HandsFreeHeadTracker;
    if (!core || !core.HeadTracker) {
      throw new Error("head-tracker-core.js did not load; run `npm run build:extension`");
    }
    HeadTrackerRef = core.HeadTracker;
  }
  return new HeadTrackerRef(...args);
}

/** Ask the offscreen document for one frame of landmarks. */
function requestFrame() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "visionFrame" }, (res) => {
      // `lastError` fires when the offscreen document is gone; treat it as "no frame"
      // rather than an unhandled rejection that would kill the tracker loop.
      if (chrome.runtime.lastError) return resolve({ marks: null, handMarks: null, gone: true });
      resolve(res || { marks: null, handMarks: null, gone: true });
    });
  });
}

/**
 * Ask the worker to make sure the offscreen document exists before we talk to it.
 * Only the worker may call chrome.offscreen, so a content script cannot open it itself.
 */
function ensureVisionHost() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "visionHost" }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: "the extension worker is asleep" });
      resolve(res || { ok: false, error: "no response from the extension worker" });
    });
  });
}

/** Reuse the exact maths the control page uses, so behaviour matches. */
const HandsFreePageBridge = {
  create,
  videoElement,
  HeadTracker,
};

if (typeof module !== "undefined" && module.exports) module.exports = HandsFreePageBridge;
if (typeof globalThis !== "undefined") globalThis.HandsFreePageBridge = HandsFreePageBridge;

function create(opts = {}) {
  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };
  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch {
        // A misbehaving listener must not stop the tracker loop.
      }
    }
  };

  // The tracker only needs a video-shaped object for its smoothing state; the real
  // camera lives in the offscreen document.
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;

  let running = false;
  let raf = 0;
  let pinch = false;
  /** Only one frame request may be in flight, or replies can arrive out of order. */
  let inFlight = false;
  /** Consecutive replies that never arrived, i.e. the offscreen host is gone. */
  let missedFrames = 0;
  let recovering = false;
  let lastErrorMessage = null;

  const cfg = {
    sensitivity: Number(opts.sensitivity) || 1,
    eyeSensitivity: Number(opts.eyeSensitivity) || 1,
    mirror: opts.mirror !== false,
    mode: ["head", "blend", "eye"].includes(opts.mode) ? opts.mode : "head",
    clickMode: opts.clickMode === "none" ? "none" : "pinch",
    // A touch more calibration than the control page defaults to, because the first
    // frames after a page load land while the user is still settling.
    calibrationFrames: 15,
    eyeMedian: 5,
  };

  const tracker = new HeadTracker({
    video,
    canvas: null,
    onStatus: (s) => emit("status", s),
    onPoint: (point) => emit("frame", { ...point, pinched: pinch }),
    onActivate: (a) => {
      if (a?.click) emit("pinch", { x: a.click.x, y: a.click.y });
      emit("activate", a);
    },
  });
  tracker.update(cfg);

  /** The offscreen host died (closed by Chrome, or the worker was recycled). Rebuild it. */
  async function recover() {
    if (recovering || !running) return;
    recovering = true;
    emit("status", { state: "starting", message: "reconnecting to the camera" });
    try {
      const host = await ensureVisionHost();
      if (!host?.ok) throw new Error(host?.error ?? "the camera host could not start");
      const res = await sendMessage("visionStart");
      if (!res?.ok) throw new Error(res?.error ?? "the camera could not be restarted");
      missedFrames = 0;
      lastErrorMessage = null;
      tracker.recalibrate();
      emit("status", { state: "running", calibrating: true });
    } catch (err) {
      lastErrorMessage = String(err?.message || err);
      emit("status", { state: "error", message: lastErrorMessage });
    } finally {
      recovering = false;
    }
  }

  function sendMessage(type) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type }, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: "no response from the vision host" });
      });
    });
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    // Never queue a second request: replies must stay in order or the cursor stutters.
    if (inFlight || recovering) return;
    inFlight = true;
    requestFrame()
      .then((res) => {
        inFlight = false;
        if (!running || !res) return;

        if (res.gone || res.running === false) {
          // The host is not answering. Try to rebuild it once, and stay honest about
          // the fact that tracking is not running rather than reporting "no face".
          missedFrames += 1;
          if (missedFrames >= 5) {
            missedFrames = 0;
            recover();
          }
          return;
        }
        missedFrames = 0;

        if (res.error) {
          lastErrorMessage = res.error;
          emit("status", { state: "error", message: res.error });
          return;
        }

        const { marks, handMarks } = res;
        const ts = res.ts ?? performance.now();

        const result = tracker.processFrame(marks, ts);
        if (!result.face) {
          // Cancel any gesture in progress so a pinch interrupted by face loss cannot
          // fire a click on reacquisition.
          tracker._pinchRun = 0;
          pinch = false;
          emit("frame", { x: tracker.point.x, y: tracker.point.y, pinched: false, faceVisible: false });
          emit("status", { state: "running", face: false, calibrating: tracker.calibrating });
          return;
        }

        emit("frame", { ...tracker.point, pinched: pinch, faceVisible: true });

        // Reuse the tracker's gesture state machine (confirm + rearm + cooldown) so the
        // extension cannot machine-gun clicks; it emits "activate" for an accepted click.
        const raw = cfg.clickMode === "pinch" ? tracker.pinching(handMarks) : false;
        pinch = tracker.updateGesture(raw, ts);

        emit("status", {
          state: "running",
          face: true,
          calibrating: tracker.calibrating,
          pinching: pinch,
          mode: cfg.mode,
          clickMode: cfg.clickMode,
        });
      })
      .catch(() => {
        inFlight = false;
        if (!running) return;
        emit("status", { state: "error", message: "tracking lost contact with the camera" });
      });
  }

  return {
    on,

    async start() {
      if (running) return { ok: true };

      emit("status", { state: "starting", message: "starting the camera" });

      // The camera and MediaPipe live in the offscreen document. Only the service worker
      // can create one, so ask it to first, otherwise the request below goes nowhere.
      const host = await ensureVisionHost();
      if (!host?.ok) {
        const error = host?.error ?? "the camera host could not start";
        emit("status", { state: "error", message: error });
        return { ok: false, error };
      }

      const res = await sendMessage("visionStart");
      if (!res?.ok) {
        const error = res?.error ?? "could not start the camera";
        emit("status", { state: "error", message: error });
        return { ok: false, error };
      }

      running = true;
      inFlight = false;
      missedFrames = 0;
      lastErrorMessage = null;
      tracker.recalibrate();
      loop();
      emit("status", { state: "running", calibrating: true, mode: cfg.mode });
      return { ok: true, hand: res.hand !== false };
    },

    stop() {
      running = false;
      recovering = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      inFlight = false;
      missedFrames = 0;
      // Release the camera in the offscreen host; if it is already gone, `visionStop`
      // simply finds nothing to stop.
      chrome.runtime.sendMessage({ type: "visionStop" }).catch(() => {});
      pinch = false;
      emit("status", { state: "stopped" });
    },

    recenter() {
      if (!running) return { ok: false, error: "tracking is off" };
      tracker.recalibrate();
      emit("status", { state: "running", calibrating: true, mode: cfg.mode });
      return { ok: true };
    },

    configure(patch) {
      const before = { ...cfg };
      Object.assign(cfg, patch || {});
      // Guard the mode again: the popup and stored settings are both user-editable.
      if (!["head", "blend", "eye"].includes(cfg.mode)) cfg.mode = "head";
      if (cfg.clickMode !== "none" && cfg.clickMode !== "pinch") cfg.clickMode = "pinch";
      tracker.update(cfg);
      // A different neutral pose makes the old baseline meaningless, so switching mode
      // must really recalibrate rather than only relabel the UI.
      if (running && before.mode !== cfg.mode) tracker.recalibrate();
      return cfg;
    },

    get video() {
      return video;
    },

    get point() {
      return { ...tracker.point };
    },
  };
}

function videoElement() {
  const v = document.createElement("video");
  v.playsInline = true;
  v.muted = true;
  v.autoplay = true;
  v.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
  return v;
}