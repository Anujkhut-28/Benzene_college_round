/**
 * Offscreen document: hosts the two browser APIs the MV3 sandbox cannot reach elsewhere.
 *
 * 1. Speech recognition. A service worker has no DOM and no microphone.
 * 2. MediaPipe. The extension CSP forbids dynamic `import()` in a content script, and
 *    a service worker cannot use `import()` at all. An offscreen document is a real
 *    extension page, so it can load the vendored MediaPipe bundle and run the models.
 *
 * It forwards transcripts and per-frame landmarks to the background worker, which owns
 * the socket. Recognition restarts itself because Chrome ends the session after a few
 * seconds of silence in some configurations.
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let listening = false;
/** Guards against two recognitions overlapping after a restart race. */
let starting = false;
let utteranceSeed = 0;
/**
 * Callbacks waiting for the recogniser to actually start, so the worker can be told the
 * real outcome instead of assuming success the moment `rec.start()` was called.
 */
const startedHooks = [];
const resolveStarted = (result) => {
  while (startedHooks.length) startedHooks.shift()(result);
};

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

let visionPromise = null;
let face = null;
let hand = null;
let visionRunning = false;
/** Consecutive frames the landmarker itself threw on; surfaced as a real error. */
let visionErrors = 0;
/**
 * Detection is driven purely by the `visionFrame` requests from the page.
 *
 * There used to be an extra requestAnimationFrame loop here as well. Both consumers
 * advanced the same `lastVideoTime` cursor, so the rAF loop consumed each camera frame
 * first and every `visionFrame` request then saw "no new frame" and answered
 * `{marks: null}`. The page therefore believed the face was permanently lost and the
 * cursor never moved, even though detection was running perfectly. One consumer only.
 */
let lastVideoTime = -1;
/** Last computed landmarks, reused when a request arrives within the same camera frame. */
let lastResult = { marks: null, handMarks: null, ts: 0 };
let lastFaceTs = 0;
let lastHandTs = 0;
/** Guard so two rapid visionStart messages cannot open the camera twice. */
let visionStarting = false;

function loadVision() {
  if (!visionPromise) {
    visionPromise = import(chrome.runtime.getURL("vendor/vision_bundle.mjs")).then(
      (mod) => (mod.default && mod.FilesetResolver ? mod.default : mod),
    );
  }
  return visionPromise;
}

async function makeLandmarker(vision, kind) {
  const fileset = await vision.FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/wasm"));
  const config = {
    baseOptions: { modelAssetPath: chrome.runtime.getURL(`vendor/${kind}_landmarker.task`), delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    numHands: 1,
  };
  const Ctor = kind === "face" ? vision.FaceLandmarker : vision.HandLandmarker;
  try {
    return await Ctor.createFromOptions(fileset, config);
  } catch {
    delete config.baseOptions.delegate;
    return await Ctor.createFromOptions(fileset, config);
  }
}

async function startVision() {
  if (visionRunning) return { ok: true, hand: Boolean(hand) };
  // Two "visionStart" messages in flight at once would each prompt for the camera and
  // leak a stream, so the second waits for the first to settle.
  if (visionStarting) return { ok: false, error: "the camera is already starting" };
  visionStarting = true;
  try {
    const video = document.getElementById("src");
    if (!video) return { ok: false, error: "the vision host is missing its video element" };
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: "this browser exposes no camera API" };
    }

    let vision;
    try {
      vision = await loadVision();
    } catch (err) {
      return { ok: false, error: `MediaPipe could not load: ${err.message}` };
    }
    if (!face) {
      try {
        face = await makeLandmarker(vision, "face");
      } catch (err) {
        return { ok: false, error: `face model unavailable: ${err.message}` };
      }
    }
    if (!hand) {
      try {
        hand = await makeLandmarker(vision, "hand");
      } catch {
        // Pinch is optional; the user can still aim and use voice.
        hand = null;
        post({ type: "offscreenStatus", payload: { message: "pinch unavailable; click is off" } });
      }
    }

    // Ask for the camera only now, so the permission prompt is tied to a user action.
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      await video.play();
    } catch (err) {
      const name = err?.name || "";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      const missing = name === "NotFoundError" || name === "OverconstrainedError";
      const detail = denied
        ? "camera permission was denied. Allow it in chrome://settings/content/camera and try again."
        : missing
          ? "no camera was found on this machine."
          : String(err?.message || err);
      return { ok: false, error: `camera blocked: ${detail}`, denied };
    }

    visionRunning = true;
    lastVideoTime = -1;
    lastResult = { marks: null, handMarks: null, ts: 0 };
    visionErrors = 0;
    return { ok: true, hand: Boolean(hand) };
  } finally {
    visionStarting = false;
  }
}

/**
 * Run detection for the newest camera frame and return the landmarks.
 * Shared by `visionFrame`; nothing else may consume the video frame.
 */
function detectNow(video) {
  if (!visionRunning || !face || !video || video.readyState < 2) return null;
  if (video.currentTime === lastVideoTime) return lastResult;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  const ts = now <= lastFaceTs ? lastFaceTs + 1 : now;
  lastFaceTs = ts;

  let marks = null;
  let handMarks = null;
  try {
    marks = face.detectForVideo(video, ts)?.faceLandmarks?.[0] ?? null;
    if (hand) {
      const hts = now <= lastHandTs ? lastHandTs + 1 : now;
      lastHandTs = hts;
      handMarks = hand.detectForVideo(video, hts)?.landmarks?.[0] ?? null;
    }
    visionErrors = 0;
  } catch {
    // Repeated throws mean the model is unusable (bad GPU delegate, lost context).
    // Report it once the threshold is crossed instead of silently showing "no face".
    visionErrors += 1;
    if (visionErrors >= 10) {
      visionErrors = 0;
      return { marks: null, handMarks: null, ts, error: "the tracking model stopped responding" };
    }
    return lastResult;
  }
  lastResult = { marks, handMarks, ts };
  return lastResult;
}

function stopVision() {
  visionRunning = false;
  visionStarting = false;
  const video = document.getElementById("src");
  const stream = video?.srcObject;
  if (stream) for (const t of stream.getTracks()) t.stop();
  if (video) video.srcObject = null;
  face?.close?.();
  face = null;
  hand?.close?.();
  hand = null;
  lastVideoTime = -1;
  lastResult = { marks: null, handMarks: null, ts: 0 };
  visionErrors = 0;
}

function post(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Start recognition and resolve once it is genuinely running.
 *
 * Resolving on `rec.start()` alone is not enough: that call only queues the request, and
 * a denied microphone or an unreachable speech service surfaces later as an `error`
 * event. The popup used to read "listening" in that window, so the feature looked active
 * while nothing was being recorded.
 */
function start() {
  if (!SpeechRecognition) {
    const error = "This browser has no Web Speech API. Use Chrome or Edge, or type commands in the panel.";
    post({ type: "offscreenError", payload: { error } });
    return Promise.resolve({ ok: false, error, unsupported: true });
  }
  if (listening && recognition) return Promise.resolve({ ok: true });
  if (starting) return Promise.resolve({ ok: true, pending: true });
  starting = true;

  // Refuse early with a clear reason rather than waiting for a silent failure.
  const settled = new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "the microphone did not start within 10 seconds" }),
      10000,
    );
    startedHooks.push(finish);
  });

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = (result[0]?.transcript || "").trim();
      if (!transcript) continue;
      const utteranceId = `u${utteranceSeed}`;
      if (result.isFinal) {
        utteranceSeed += 1;
        post({ type: "offscreenTranscript", payload: { text: transcript, final: true, utteranceId } });
      } else {
        post({ type: "offscreenTranscript", payload: { text: transcript, final: false, utteranceId } });
      }
    }
  };

  rec.onstart = () => {
    starting = false;
    recognition = rec;
    listening = true;
    post({ type: "offscreenReady" });
    resolveStarted({ ok: true });
  };

  rec.onerror = (event) => {
    // An error means this recogniser is finished; `onend` does not always follow a
    // permission failure, so the latch is released here. Leaving it set made the next
    // start() report "already starting" and the popup show a microphone that is off.
    starting = false;
    recognition = null;
    // "no-speech" and "aborted" are routine; only surface real failures.
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      listening = false;
      const error = "Microphone permission was denied. Allow it in chrome://settings/content/microphone, then try again.";
      post({ type: "offscreenError", payload: { error, denied: true } });
      resolveStarted({ ok: false, error, denied: true });
      return;
    }
    if (event.error !== "no-speech" && event.error !== "aborted") {
      const error = `Speech recognition failed: ${event.error}. Chrome sends audio to Google's service, which needs a network connection.`;
      post({ type: "offscreenError", payload: { error } });
      resolveStarted({ ok: false, error });
    }
  };

  rec.onend = () => {
    recognition = null;
    starting = false;
    // Chrome ends sessions on its own; keep going while the user wants to listen.
    if (listening) {
      setTimeout(() => {
        if (listening) start();
      }, 250);
    }
  };

  try {
    // The prompt for microphone access is raised by this call, so it is only ever
    // reached from a user action (the popup button or its keyboard shortcut).
    rec.start();
  } catch (err) {
    starting = false;
    const error = `The microphone could not be started: ${String(err?.message || err)}`;
    post({ type: "offscreenError", payload: { error } });
    resolveStarted({ ok: false, error });
    return Promise.resolve({ ok: false, error });
  }
  return settled;
}

function stop() {
  listening = false;
  starting = false;
  const rec = recognition;
  recognition = null;
  if (!rec) return;
  rec.onend = null;
  rec.onstart = null;
  try {
    rec.abort();
  } catch {
    // Already stopped.
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ---- vision ----
  if (msg?.type === "visionStart") {
    startVision()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "visionStop") {
    stopVision();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "visionFrame") {
    // The page polls for the newest landmarks. Detection happens here and nowhere else.
    if (!visionRunning || visionStarting) {
      sendResponse({ marks: null, handMarks: null, running: false });
      return false;
    }
    const result = detectNow(document.getElementById("src"));
    sendResponse({ ...(result ?? { marks: null, handMarks: null }), running: true });
    return false;
  }

  // ---- speech ----
  if (msg?.type === "offscreenStart") {
    // Report the recogniser's real outcome: a denied microphone or an unsupported
    // browser must come back as a failure, not as a silent success.
    Promise.resolve(start())
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "offscreenStop") {
    stop();
    resolveStarted({ ok: false, error: "stopped" });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "offscreenReady") {
    // Recognised so the worker's own broadcast is not reported as unhandled;
    // recognition itself is announced by `rec.start()`.
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "offscreenError") {
    // The worker's broadcast is just echoing our own message back. Acknowledge it so
    // it is not reported as unhandled, but do not re-post: `offscreenError` already
    // has a handler in the worker and relaying here would loop.
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

window.addEventListener("pagehide", () => {
  // Never leave the camera light on after the host goes away.
  try {
    stopVision();
    stop();
  } catch {
    // Tearing down anyway.
  }
  post({ type: "offscreenClosed" });
});