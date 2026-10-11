/**
 * Hands-free pointer driven by webcam head pose (default) or eye gaze (experimental).
 * Runs in the control page and forwards pointer events to the controlled page over the WebSocket.
 * The controlled page snaps the pointer to the nearest clickable element (see overlay.js).
 *
 * Smoothing: One Euro filter on the cursor + a small leash. Eye modes add a median filter on the
 * raw iris and a much stiffer filter, because iris landmarks are far noisier than head pose.
 */

const DEFAULTS = {
  enabled: false,
  mode: "head", // "head" (recommended) | "blend" (experimental) | "eye" (experimental)
  sensitivity: 1.0,
  sensitivityX: 1.0,
  sensitivityY: 1.0,
  // head mode One Euro filter parameters (well-damped at rest, responsive on movement)
  headMinCutoff: 0.8,
  headBeta: 0.08,
  // eye / blend modes
  minCutoff: 0.35,
  beta: 0.05,
  // Iris landmarks are much noisier than head pose, so eye modes get their own,
  // wider dead zone and a stiffer filter. Without this the cursor twitches constantly.
  eyeDeadzone: 0.02,
  eyeSensitivity: 1.0,
  eyeMedian: 1, // start() raises this to 5
  margin: 0.02,
  deadzone: 0.006, // smooth dead-zone to suppress resting head micro-tremor
  deadzoneX: null, // null => fall back to `deadzone`
  deadzoneY: null,
  /**
   * Max cursor travel per second, in normalised screen units. Clamps landmark
   * teleports (a re-detected face, a mirrored frame, a tracker hiccup) without
   * capping how fast a real head turn can move the cursor.
   */
  maxSpeed: 3.5,
  /** Frames of landmarks median-filtered before use; kills single-frame spikes. */
  landmarkMedian: 3,
  mirror: true,
  showVideo: true,
  clickMode: "pinch",
  pinchOn: 0.25,
  pinchOff: 0.35,
  /** Consecutive pinch samples required before a gesture is accepted. */
  pinchConfirmFrames: 2,
  /**
   * Minimum gap between two accepted pinch clicks. Without it a user holding the
   * gesture steady across a landmark wobble can fire a second click at the same spot.
   */
  pinchCooldownMs: 450,
  /** Hold the hand open (pinchOff) for this long before another pinch can be armed. */
  pinchRearmMs: 120,
  /** Consecutive frames the hand may be missing before a held pinch is treated as released. */
  handMissTolerance: 3,
  calibrationFrames: 1, // start() raises this to 15
  blinkHoldMs: 150,
};

const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const NOSE = 1;
const L_CHEEK = 234;
const R_CHEEK = 454;

/** Frames the hand may be missing before a held pinch counts as released. */
const HAND_MISS_TOLERANCE = 3;

const EYE_GAIN_X = 6.5;
const EYE_GAIN_Y = 8.5;
// Head pointing maps the nose's position between the cheeks onto the screen. A
// comfortable head turn spans roughly +-0.09 of image width; these gains put the
// screen edges at about half that, so the full screen is reachable without
// straining, while small adjustments still feel precise.
const HEAD_GAIN_X = 4.5;
const HEAD_GAIN_Y = 5.5;

/** One Euro filter: adaptive low-pass filter, rock-steady at rest, low-latency on fast moves. */
export class OneEuro {
  constructor() {
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    if (!(cutoff > 0) || !(dt > 0)) return 0;
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, tMs, minCutoff = 0.8, beta = 0.08, dcutoff = 1.0) {
    // A non-finite sample (NaN from a degenerate landmark) must never poison the state.
    if (!Number.isFinite(v)) return this.x ?? 0;
    if (this.x === null || !Number.isFinite(this.x)) {
      this.x = v;
      this.dx = 0;
      this.t = tMs;
      return v;
    }
    const rawDt = (tMs - this.t) / 1000;
    if (!(rawDt > 0)) return this.x;
    // If a large pause happened (> 250ms), recover smoothly without derivative spike
    if (rawDt > 0.25) {
      this.dx = 0;
      this.t = tMs;
      this.x = this.x + (v - this.x) * 0.5;
      return this.x;
    }
    const dt = Math.max(1e-3, Math.min(0.1, rawDt));
    this.t = tMs;
    const rawDx = (v - this.x) / dt;
    this.dx += OneEuro.alpha(dcutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/** Smooth continuous dead-zone: zero jump across the boundary. */
export function applySmoothDeadzone(val, center = 0.5, deadzone = 0.005) {
  if (deadzone <= 0) return val;
  const delta = val - center;
  const absDelta = Math.abs(delta);
  if (absDelta <= deadzone) return center;
  const maxRange = delta > 0 ? (1 - center) : center;
  const usableRange = Math.max(1e-4, maxRange - deadzone);
  const normalizedDelta = (absDelta - deadzone) / usableRange;
  return center + Math.sign(delta) * Math.min(maxRange, normalizedDelta * maxRange);
}

/** Robust trimmed mean: discards top and bottom extremes to resist calibration twitches. */
export function trimmedMean(arr, trimFraction = 0.2) {
  if (!arr || !arr.length) return 0;
  if (arr.length <= 2) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const sorted = [...arr].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(trimCount, sorted.length - trimCount);
  return kept.reduce((a, b) => a + b, 0) / (kept.length || 1);
}

const newCal = () => ({ n: 0, yaws: [], pitches: [], faceWidths: [], ex: [], ey: [] });

export class HeadTracker {
  constructor({ video, canvas, onStatus, onPoint, onActivate }) {
    this.video = video;
    this.canvas = canvas;
    this.onStatus = onStatus || (() => {});
    this.onPoint = onPoint || (() => {});
    this.onActivate = onActivate || (() => {});
    this.cfg = { ...DEFAULTS };
    this.landmarker = null;
    this.handLandmarker = null;
    this.running = false;
    this.raf = 0;
    this.point = { x: 0.5, y: 0.5 };
    this.smooth = { x: 0.5, y: 0.5 };
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.calibrating = true;
    this._cal = newCal();
    this.baseline = null;
    this.eyeBase = null;
    this._lastGaze = null;
    this._isBlinking = false;
    this._blinkUntil = 0;
    this._eyeBuf = [];
    this._lastVideoTime = -1;
    this._frame = 0;
    this._pinch = false;
    this._handMisses = 0;
    this.pinched = false;
    this.pinchWasDown = false;
    this._pinchRun = 0;
    this._armed = true;
    this._rearmAt = 0;
    this._lastPinchAt = 0;
    this._lostFrames = 0;
    this._reacquireFrames = 0;
    this._hasValidPoint = false;
    this._prevRawPoint = null;
    this._prevPointTime = 0;
  }

  get config() {
    return { ...this.cfg };
  }

  update(patch) {
    Object.assign(this.cfg, patch || {});
    // The hand model is only loaded on demand, so switching Click to "Pinch" after
    // tracking has started would otherwise leave pinch-to-click silently dead.
    if (this.running && this.cfg.clickMode === "pinch" && !this.handLandmarker) {
      this.loadHands().catch(() => {});
    }
    return this.cfg;
  }

  async start() {
    if (this.running) return { ok: true };
    this.onStatus({ state: "starting" });
    try {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
      const fileset = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
      );
      const faceConfig = {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
      };
      try {
        this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, faceConfig);
      } catch {
        delete faceConfig.baseOptions.delegate;
        this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, faceConfig);
      }
    } catch (err) {
      this.onStatus({ state: "error", message: `head model unavailable: ${err.message}` });
      return { ok: false, error: String(err.message || err) };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();
    } catch (err) {
      this.onStatus({ state: "error", message: `camera blocked: ${err.message}` });
      return { ok: false, error: String(err.message || err) };
    }

    this.running = true;
    this.cfg.enabled = true;
    this.cfg.calibrationFrames = Math.max(this.cfg.calibrationFrames, 15);
    this.cfg.eyeMedian = Math.max(this.cfg.eyeMedian, 5);
    this.recalibrate();
    this.onStatus({ state: "running" });
    if (this.cfg.clickMode === "pinch") await this.loadHands();
    this.loop();
    return { ok: true };
  }

  async loadHands() {
    if (this.handLandmarker) return { ok: true };
    try {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
      const fileset = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
      );
      const handConfig = {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 1,
      };
      try {
        this.handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, handConfig);
      } catch {
        delete handConfig.baseOptions.delegate;
        this.handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, handConfig);
      }
      return { ok: true };
    } catch (err) {
      this.onStatus({ state: "running", message: `pinch unavailable: ${err.message}` });
      return { ok: false, error: String(err.message || err) };
    }
  }

  /** True while thumb and index are pinched (normalised by hand size, with hysteresis). */
  pinching(hand) {
    if (!hand || hand.length < 21) {
      // A frame with no hand is a tracking dropout, not a deliberate release. Clear the
      // latch only after several consecutive misses, so one bad frame cannot turn into a
      // phantom second click when the hand reappears still closed.
      this._handMisses = (this._handMisses ?? 0) + 1;
      if (this._handMisses >= (this.cfg.handMissTolerance ?? HAND_MISS_TOLERANCE)) {
        this.pinched = false;
        this._handMisses = 0;
      }
      // Report the latch, not "no hand", so the caller's rising-edge detection does
      // not see a release-and-repress across a dropped frame.
      return this.pinched;
    }
    this._handMisses = 0;
    const thumb = hand[4];
    const index = hand[8];
    const wrist = hand[0];
    const middle = hand[9];
    if (!thumb || !index || !wrist || !middle) return false;
    const handSize = Math.hypot(middle.x - wrist.x, middle.y - wrist.y) || 0.1;
    const d = Math.hypot(thumb.x - index.x, thumb.y - index.y) / handSize;
    if (this.pinched) {
      if (d > this.cfg.pinchOff) this.pinched = false;
    } else if (d < this.cfg.pinchOn) {
      this.pinched = true;
    }
    return this.pinched;
  }

  stop() {
    this.running = false;
    this.cfg.enabled = false;
    // Guarded so stop() is safe to call outside a DOM context (tests, service shutdown).
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = 0;
    const stream = this.video?.srcObject;
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.landmarker?.close?.();
    this.landmarker = null;
    this.handLandmarker?.close?.();
    this.handLandmarker = null;
    this.pinched = false;
    this.pinchWasDown = false;
    this._pinch = false;
    this._handMisses = 0;
    this._pinchRun = 0;
    this._armed = true;
    this._rearmAt = 0;
    this._lastPinchAt = 0;
    this._lastVideoTime = -1;
    this.onStatus((this._lastStatus = { state: "stopped" }));
  }

  recalibrate() {
    this.calibrating = true;
    this._cal = newCal();
    this.baseline = null;
    this.eyeBase = null;
    this._lastGaze = null;
    this._isBlinking = false;
    this._blinkUntil = 0;
    this._eyeBuf = [];
    this._pxBuf = [];
    this._pyBuf = [];
    this._lostSince = 0;
    this.fx.reset();
    this.fy.reset();
    this.smooth = { x: 0.5, y: 0.5 };
    this.point = { x: 0.5, y: 0.5 };
    this._lostFrames = 0;
    this._reacquireFrames = 0;
    this._hasValidPoint = false;
    this._prevRawPoint = null;
    this._prevPointTime = 0;
    this._handMisses = 0;
    this._pxBuf = [];
    this._pyBuf = [];
    this._lostSince = 0;
  }

  processFrame(marks, ts = performance.now()) {
    if (!marks) {
      this._lostFrames++;
      this._reacquireFrames = 0;
      this._prevRawPoint = null;
      if (!this._lostSince) this._lostSince = ts;
      return {
        point: { ...this.point },
        face: false,
        lost: true,
        lostForMs: Math.round(ts - this._lostSince),
        calibrating: this.calibrating,
      };
    }

    const p = this.compute(marks);
    if (!p) {
      this._lostFrames++;
      this._reacquireFrames = 0;
      this._prevRawPoint = null;
      if (!this._lostSince) this._lostSince = ts;
      return {
        point: { ...this.point },
        face: false,
        lost: true,
        lostForMs: Math.round(ts - this._lostSince),
        calibrating: this.calibrating,
      };
    }

    if (this.calibrating) {
      this._prevRawPoint = { ...p };
      this._prevPointTime = ts;
      this.smooth = { ...p };
      this.point = { ...p };
      return {
        point: { ...this.point },
        face: true,
        calibrating: true,
      };
    }

    // Reacquisition smoothing after face tracking was lost
    if (this._lostFrames > 0) {
      // A long absence means the user has almost certainly moved: leaned closer,
      // turned away, or shifted seat. The old neutral pose no longer describes them,
      // so re-establish it rather than yanking the cursor across the screen to a
      // position derived from a stale baseline.
      const awayMs = this._lostSince ? ts - this._lostSince : 0;
      if (awayMs > (this.cfg.recalibrateAfterMs ?? 2000)) {
        this._lostSince = 0;
        this.recalibrate();
        return { point: { ...this.point }, face: true, recalibrating: true, calibrating: true };
      }
      this._reacquireFrames++;
      if (this._hasValidPoint) {
        this.fx.x = this.point.x;
        this.fy.x = this.point.y;
        this.fx.dx = 0;
        this.fy.dx = 0;
        this.fx.t = ts;
        this.fy.t = ts;
      }
      if (this._reacquireFrames < 2) {
        this._prevRawPoint = { ...p };
        this._prevPointTime = ts;
        return {
          point: { ...this.point },
          face: true,
          reacquiring: true,
          calibrating: false,
        };
      }
      this._lostFrames = 0;
      this._reacquireFrames = 0;
      this._lostSince = 0;
    }

    this._lostSince = 0;
    const dtSec = this._prevPointTime > 0 ? Math.max(1e-3, (ts - this._prevPointTime) / 1000) : 0.033;
    this._prevPointTime = ts;

    // Median over the last few output points. A landmark spike that survives the speed
    // limiter still cannot pull the cursor, because it is outvoted by its neighbours.
    if (!Array.isArray(this._pxBuf)) this._pxBuf = [];
    if (!Array.isArray(this._pyBuf)) this._pyBuf = [];
    const rawTarget = { x: p.x, y: p.y };
    if (this._prevRawPoint && this._hasValidPoint) {
      // Rate-limit in screen-fractions per second rather than per frame, so the limit
      // is the same at 15 fps and 60 fps. The reference is the previous *raw* target,
      // not the filtered cursor: comparing against the filtered value compounds the
      // smoothing lag into an extra artificial delay, which reads as sluggishness.
      const stepX = rawTarget.x - this._prevRawPoint.x;
      const stepY = rawTarget.y - this._prevRawPoint.y;
      const stepDist = Math.hypot(stepX, stepY);
      const maxStep = this.cfg.maxSpeed * dtSec;
      if (stepDist > maxStep) {
        const scale = maxStep / stepDist;
        rawTarget.x = this._prevRawPoint.x + stepX * scale;
        rawTarget.y = this._prevRawPoint.y + stepY * scale;
      }
    }
    this._prevRawPoint = { x: rawTarget.x, y: rawTarget.y };

    const headOnly = this.cfg.mode === "head";
    const minCutoff = headOnly ? this.cfg.headMinCutoff : this.cfg.minCutoff;
    const beta = headOnly ? this.cfg.headBeta : this.cfg.beta;

    const fx = clamp01(this.fx.filter(rawTarget.x, ts, minCutoff, beta));
    const fy = clamp01(this.fy.filter(rawTarget.y, ts, minCutoff, beta));

    // A 3-tap median here would cost a frame of lag on every legitimate move, which reads
    // as sluggishness. The speed limiter above already removes teleports, and the One
    // Euro filter removes jitter, so the median is deliberately not used on the
    // smoothed output.
    this.smooth = { x: fx, y: fy };
    this.point = { x: fx, y: fy };
    this._hasValidPoint = true;

    return {
      point: { ...this.point },
      face: true,
      calibrating: false,
    };
  }

  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const v = this.video;
    if (!v || v.readyState < 2 || !this.landmarker) return;

    // Camera ~30 fps, rAF at display rate: skip duplicate frames.
    if (v.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = v.currentTime;

    const now = performance.now();
    const ts = now <= (this._lastFaceTime || 0) ? (this._lastFaceTime || 0) + 1 : now;
    this._lastFaceTime = ts;

    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch {
      return;
    }
    const marks = res?.faceLandmarks?.[0];

    const frameResult = this.processFrame(marks, ts);
    if (!frameResult) return;

    if (!frameResult.face) {
      // The face is gone, so the cursor position is no longer meaningful. Also drop any
      // in-progress gesture: resuming a pinch the user had already completed by the
      // time the face returned would fire an unwanted click.
      this._pinchRun = 0;
      this.onStatus((this._lastStatus = { state: "running", face: false }));
      this.draw(null);
      return;
    }

    this.draw(marks);
    this.onPoint(this.point);

    // Hand model is the expensive part; every second frame is plenty for a pinch.
    this._frame += 1;
    const wantPinch = this.cfg.clickMode === "pinch" && this.handLandmarker;
    if (wantPinch && this._frame % 2 === 0) this._pinch = this.detectPinch(v);
    const rawPinch = wantPinch ? this._pinch : false;

    const pinch = this.updateGesture(rawPinch, this._lastFaceTime);
    this.onStatus((this._lastStatus = {
      state: "running",
      face: true,
      calibrating: this.calibrating,
      pinching: pinch,
      blinking: this._isBlinking,
    }));
  }

  /**
   * Turn a raw pinch sample into an accepted click, with three independent guards:
   *   confirm - N consecutive samples, so one noisy frame cannot click;
   *   rearm - the hand must visibly open again before another click is allowed;
   *   cooldown - a minimum gap, so holding the gesture cannot machine-gun clicks.
   * Returns the visual "is the gesture currently held" state.
   */
  updateGesture(rawPinch, ts = performance.now()) {
    if (rawPinch) this._pinchRun += 1;
    else this._pinchRun = 0;
    const confirmed = this._pinchRun >= (this.cfg.pinchConfirmFrames ?? 2);

    // Rearm requires the *raw* signal to be open, not the latched visual state: after a
    // click, `pinched` stays true until the hand actually opens, and gating on it
    // would mean the timer never starts, so a second pinch could never be accepted.
    if (rawPinch) {
      this._rearmAt = 0;
    } else {
      if (!this._rearmAt) this._rearmAt = ts;
      if (ts - this._rearmAt >= (this.cfg.pinchRearmMs ?? 120)) this._armed = true;
    }

    // Visual state: the gesture is "held" while either the raw or latched signal is on.
    const held = rawPinch || this.pinched;
    const cooled = ts - this._lastPinchAt >= (this.cfg.pinchCooldownMs ?? 450);
    if (confirmed && this._armed && cooled) {
      this._lastPinchAt = ts;
      this._armed = false;
      this._pinchRun = 0;
      this.onActivate({ click: { ...this.point }, pinch: true });
    }
    this.pinched = held;
    return held;
  }

  detectPinch(v) {
    if (!this.handLandmarker) return false;
    try {
      const now = performance.now();
      const ts = now <= (this._lastHandTime || 0) ? (this._lastHandTime || 0) + 1 : now;
      this._lastHandTime = ts;
      const r = this.handLandmarker.detectForVideo(v, ts);
      return this.pinching(r?.landmarks?.[0]);
    } catch {
      return false;
    }
  }

  compute(marks) {
    const nose = marks[NOSE];
    const leftCheek = marks[L_CHEEK];
    const rightCheek = marks[R_CHEEK];
    if (!nose || !leftCheek || !rightCheek) return null;
    if (!finitePoint(nose) || !finitePoint(leftCheek) || !finitePoint(rightCheek)) return null;

    const midX = (leftCheek.x + rightCheek.x) / 2;
    const midY = (leftCheek.y + rightCheek.y) / 2;
    // Euclidean cheek distance to resist head tilt
    const cheekDist = Math.max(0.04, Math.hypot(rightCheek.x - leftCheek.x, rightCheek.y - leftCheek.y));
    // Median over the last few frames. A single bad landmark detection otherwise moves
    // the cursor for a whole frame; the median discards it outright.
    const yaw = (nose.x - midX) / cheekDist;
    const pitch = (nose.y - midY) / cheekDist;
    // Only a genuinely implausible face size is rejected: a user moving closer to the
    // camera is normal and must not be treated as tracking loss.
    if (!Number.isFinite(cheekDist) || cheekDist > 1.5) return null;

    const needEye = this.cfg.mode !== "head" && marks.length >= 478;
    const eye = needEye ? this.eyeSample(marks) : null;

    if (this.calibrating) {
      const usable = !needEye || (eye && !eye.blinking);
      if (usable) {
        const c = this._cal;
        c.n += 1;
        c.yaws.push(yaw);
        c.pitches.push(pitch);
        c.faceWidths.push(cheekDist);
        if (needEye && eye) {
          c.ex.push(eye.x);
          c.ey.push(eye.y);
        }
        if (c.n >= this.cfg.calibrationFrames) {
          this.baseline = {
            yaw: trimmedMean(c.yaws, 0.2),
            pitch: trimmedMean(c.pitches, 0.2),
            faceWidth: trimmedMean(c.faceWidths, 0.2),
          };
          if (c.ex.length > 0) {
            this.eyeBase = {
              x: trimmedMean(c.ex, 0.2),
              y: trimmedMean(c.ey, 0.2),
            };
          }
          this.calibrating = false;
        }
      }
      return { x: 0.5, y: 0.5 };
    }

    const gaze = this.eyeGaze(eye);

    let rawX;
    let rawY;
    if (gaze && this.cfg.mode === "eye") {
      const headX = this.centered(yaw, "yaw");
      const headY = this.centered(pitch, "pitch");
      rawX = gaze.x + (headX - 0.5) * 0.4;
      rawY = gaze.y + (headY - 0.5) * 0.4;
    } else if (gaze && this.cfg.mode === "blend") {
      rawX = (gaze.x + this.centered(yaw, "yaw")) / 2;
      rawY = (gaze.y + this.centered(pitch, "pitch")) / 2;
    } else {
      rawX = this.centered(yaw, "yaw");
      rawY = this.centered(pitch, "pitch");
    }

    const usingEyes = this.cfg.mode !== "head" && Boolean(gaze);
    // Eye modes get their own gain multiplier so a user who cannot hold their head still
    // can turn the whole gain down without losing head control, and vice versa.
    const eyeGain = usingEyes ? (this.cfg.eyeSensitivity ?? 1) : 1;
    const sx = (this.cfg.sensitivityX ?? 1.0) * (this.cfg.sensitivity ?? 1.0) * eyeGain;
    const sy = (this.cfg.sensitivityY ?? 1.0) * (this.cfg.sensitivity ?? 1.0) * eyeGain;
    let x = 0.5 + (rawX - 0.5) * sx;
    let y = 0.5 + (rawY - 0.5) * sy;
    if (this.cfg.mirror) x = 1 - x;

    const m = this.cfg.margin;
    x = clamp01((x - m) / (1 - 2 * m));
    y = clamp01((y - m) / (1 - 2 * m));

    // Per-axis dead zones: vertical head motion carries far more sensor noise than
    // horizontal, so one shared threshold either jitters vertically or feels sluggish.
    // Iris landmarks are noisier still, so eye modes widen it further.
    const dz = usingEyes ? Math.max(this.cfg.deadzone ?? 0, this.cfg.eyeDeadzone ?? 0) : this.cfg.deadzone ?? 0;
    x = applySmoothDeadzone(x, 0.5, this.cfg.deadzoneX ?? dz);
    y = applySmoothDeadzone(y, 0.5, this.cfg.deadzoneY ?? dz);
    return { x: clamp01(x), y: clamp01(y) };
  }

  getDiagnostics() {
    return {
      running: this.running,
      calibrating: this.calibrating,
      mode: this.cfg.mode,
      // This is an *estimate* of gaze direction from iris position within the eye
      // aperture plus head pose. It is not calibrated against a screen and cannot know
      // where the user is actually looking. UI should not claim otherwise.
      gazeIsEstimated: true,
      blinking: this._isBlinking,
      lastStatus: this._lastStatus ?? null,
      baseline: this.baseline ? { ...this.baseline } : null,
      rawPoint: this._prevRawPoint ? { ...this._prevRawPoint } : null,
      filteredPoint: { ...this.point },
      lostFrames: this._lostFrames,
      reacquireFrames: this._reacquireFrames,
      hasValidPoint: this._hasValidPoint,
      filter: {
        x: this.fx.x,
        y: this.fy.x,
        dx: this.fx.dx,
        dy: this.fy.dx,
      },
      config: { ...this.cfg },
    };
  }

  centered(value, axis) {
    if (this.baseline?.[axis] == null) {
      this.baseline = { ...(this.baseline || {}), [axis]: value };
    }
    const gain = axis === "yaw" ? HEAD_GAIN_X : HEAD_GAIN_Y;
    return 0.5 + (value - this.baseline[axis]) * gain;
  }

  /**
   * Raw iris position (average of open eyes, median-filtered over the last few frames), or
   * { blinking: true } while lids are closed and for blinkHoldMs afterwards, or null.
   */
  eyeSample(marks) {
    if (!marks || marks.length < 478) return null;
    const left = irisOffset(marks, L_IRIS, 33, 133, 159, 145);
    const right = irisOffset(marks, R_IRIS, 362, 263, 386, 374);
    if (!left && !right) return null;

    const now = performance.now();
    const open = [left, right].filter((e) => e && !e.blinking);
    if (!open.length) {
      this._blinkUntil = now + this.cfg.blinkHoldMs;
      this._isBlinking = true;
      return { blinking: true };
    }
    if (now < this._blinkUntil) {
      this._isBlinking = true;
      return { blinking: true };
    }
    this._isBlinking = false;

    const raw = {
      x: open.reduce((a, e) => a + e.x, 0) / open.length,
      y: open.reduce((a, e) => a + e.y, 0) / open.length,
    };
    this._eyeBuf.push(raw);
    if (this._eyeBuf.length > this.cfg.eyeMedian) this._eyeBuf.shift();
    return { x: median(this._eyeBuf.map((e) => e.x)), y: median(this._eyeBuf.map((e) => e.y)) };
  }

  eyeGaze(eye) {
    if (!eye) return null;
    // While blinking, hold the last known gaze. Returning null here instead would send
    // the cursor to the head-pose value for that frame, which the One Euro filter then
    // has to recover from - a blink every few seconds would read as a visible stutter.
    if (eye.blinking) return this._lastGaze || null;
    if (!Number.isFinite(eye.x) || !Number.isFinite(eye.y)) return this._lastGaze || null;
    if (!this.eyeBase) this.eyeBase = { x: eye.x, y: eye.y };
    // An eye sample far outside anything plausible means the iris landmarks jumped
    // rather than the user looking sharply sideways. Treat it as a dropout so the
    // cursor holds instead of snapping to an edge.
    if (Math.abs(eye.x - this.eyeBase.x) > 0.6 || Math.abs(eye.y - this.eyeBase.y) > 0.6) {
      return this._lastGaze || null;
    }
    const gaze = {
      x: 0.5 + (eye.x - this.eyeBase.x) * EYE_GAIN_X,
      y: 0.5 + (eye.y - this.eyeBase.y) * EYE_GAIN_Y,
    };
    this._lastGaze = gaze;
    return gaze;
  }

  draw(marks) {
    const c = this.canvas;
    if (!c) return;
    const w = (c.width = this.video?.clientWidth || 320);
    const h = (c.height = this.video?.clientHeight || 240);
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (marks && this.cfg.showVideo) {
      const pts = [marks[NOSE], marks[L_CHEEK], marks[R_CHEEK]];
      if (this.cfg.mode !== "head" && marks.length >= 478) {
        for (const i of [468, 473]) {
          if (marks[i]) pts.push(marks[i]);
        }
      }
      for (const m of pts) {
        if (!m) continue;
        const mx = (this.cfg.mirror ? 1 - m.x : m.x) * w;
        ctx.fillStyle = "rgba(120,220,255,0.8)";
        ctx.beginPath();
        ctx.arc(mx, m.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.strokeStyle = this.pinched ? "rgba(255,92,92,0.9)" : "rgba(120,220,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.point.x * w, this.point.y * h, this.pinched ? 12 : 8, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function median(a) {
  if (!Array.isArray(a) || !a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}

function finitePoint(p) {
  return Number.isFinite(p?.x) && Number.isFinite(p?.y);
}

/**
 * Push a sample and return the median of the buffer. `keep` of 1 disables filtering.
 * A single outlier in a 3-frame window is discarded by the median outright.
 */
/** Append a sample, drop non-finite ones, and bound the buffer at `keep`. */
function pushMedian(buf, value, keep = 3) {
  if (!Array.isArray(buf)) return [];
  if (Number.isFinite(value)) buf.push(value);
  while (buf.length > keep) buf.shift();
  return buf;
}

/** Iris centre relative to eye corners, normalized by eye width, with eyelid-closure detection. */
function irisOffset(marks, irisIdx, cornerA, cornerB, lidTop, lidBottom) {
  const a = marks[cornerA];
  const b = marks[cornerB];
  if (!a || !b) return null;

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const i of irisIdx) {
    const p = marks[i];
    if (!p) continue;
    sx += p.x;
    sy += p.y;
    n++;
  }
  if (!n) return null;
  const irisX = sx / n;
  const irisY = sy / n;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const eyeWidth = Math.hypot(dx, dy);
  if (eyeWidth < 1e-4) return null;

  const top = marks[lidTop];
  const bottom = marks[lidBottom];
  let isBlinking = false;
  if (top && bottom) {
    const lidDist = Math.hypot(top.x - bottom.x, top.y - bottom.y);
    if (lidDist / eyeWidth < 0.12) isBlinking = true;
  }

  const normX = ((irisX - a.x) * dx + (irisY - a.y) * dy) / (eyeWidth * eyeWidth);
  const midY = (a.y + b.y) / 2;
  const normY = 0.5 + ((irisY - midY) / eyeWidth) * 2.5;

  return { x: normX, y: normY, blinking: isBlinking };
}

// Expose the classes on `window` so the file also works when loaded as a plain
// script (the control page imports it as a module, but the extension's generated
// build and anyone embedding it directly rely on the global).
if (typeof window !== "undefined" && !window.HandsFreeTracker) {
  window.HandsFreeTracker = {
    HeadTracker,
    HandsFreeTracker: HeadTracker,
    OneEuro,
    applySmoothDeadzone,
    trimmedMean,
    irisOffset,
  };
}