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
  // head mode
  headMinCutoff: 1.0,
  headBeta: 4,
  headHold: 0.004,
  // eye / blend modes
  minCutoff: 0.25,
  beta: 0.7,
  holdRadius: 0.008,
  eyeMedian: 1, // start() raises this to 5
  margin: 0.05,
  deadzone: 0.003,
  mirror: true,
  showVideo: true,
  clickMode: "pinch",
  pinchOn: 0.25,
  pinchOff: 0.35,
  calibrationFrames: 1, // start() raises this to 20
  blinkHoldMs: 150,
};

const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const NOSE = 1;
const L_CHEEK = 234;
const R_CHEEK = 454;

const EYE_GAIN_X = 6.5;
const EYE_GAIN_Y = 8.5;
const HEAD_GAIN_X = 5.0;
const HEAD_GAIN_Y = 6.0;

/** One Euro filter: adaptive low-pass, steady at rest, responsive on fast moves. */
class OneEuro {
  constructor() {
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, tMs, minCutoff, beta) {
    if (this.x === null) {
      this.x = v;
      this.t = tMs;
      return v;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const rawDx = (v - this.x) / dt;
    this.dx += OneEuro.alpha(1, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

const newCal = () => ({ n: 0, yaw: 0, pitch: 0, ex: 0, ey: 0, en: 0 });

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
    this.pinched = false;
    this.pinchWasDown = false;
  }

  get config() {
    return { ...this.cfg };
  }

  update(patch) {
    Object.assign(this.cfg, patch || {});
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
    this.cfg.calibrationFrames = Math.max(this.cfg.calibrationFrames, 20);
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
      this.pinched = false;
      return false;
    }
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
    cancelAnimationFrame(this.raf);
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
    this._lastVideoTime = -1;
    this.onStatus({ state: "stopped" });
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
    this.fx.reset();
    this.fy.reset();
    this.smooth = { x: 0.5, y: 0.5 };
    this.point = { x: 0.5, y: 0.5 };
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
    if (!marks) {
      this.fx.reset();
      this.fy.reset();
      this._eyeBuf = [];
      this.onStatus({ state: "running", face: false });
      this.draw(null);
      return;
    }

    const p = this.compute(marks);
    if (!p) return;

    const headOnly = this.cfg.mode === "head";
    const minCutoff = headOnly ? this.cfg.headMinCutoff : this.cfg.minCutoff;
    const beta = headOnly ? this.cfg.headBeta : this.cfg.beta;
    const hold = headOnly ? this.cfg.headHold : this.cfg.holdRadius;

    this.smooth = {
      x: this.fx.filter(p.x, ts, minCutoff, beta),
      y: this.fy.filter(p.y, ts, minCutoff, beta),
    };

    // Leash: ignore wobble smaller than `hold`, then trail the target by that radius.
    const dx = this.smooth.x - this.point.x;
    const dy = this.smooth.y - this.point.y;
    const dist = Math.hypot(dx, dy);
    if (dist > hold) {
      const k = (dist - hold) / dist;
      this.point = { x: this.point.x + dx * k, y: this.point.y + dy * k };
    }

    this.draw(marks);
    this.onPoint(this.point);

    // Hand model is the expensive part; every second frame is plenty for a pinch.
    this._frame += 1;
    const wantPinch = this.cfg.clickMode === "pinch" && this.handLandmarker;
    if (wantPinch && this._frame % 2 === 0) this._pinch = this.detectPinch(v);
    const pinch = wantPinch ? this._pinch : false;
    if (pinch && !this.pinchWasDown) {
      this.onActivate({ click: { ...this.point }, pinch: true });
    }
    this.pinchWasDown = pinch;
    this.onStatus({ state: "running", face: true, calibrating: this.calibrating, pinching: pinch });
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

    const midX = (leftCheek.x + rightCheek.x) / 2;
    const midY = (leftCheek.y + rightCheek.y) / 2;
    const cheekDist = Math.max(0.04, Math.abs(rightCheek.x - leftCheek.x));
    const yaw = (nose.x - midX) / cheekDist;
    const pitch = (nose.y - midY) / cheekDist;

    const needEye = this.cfg.mode !== "head" && marks.length >= 478;
    const eye = needEye ? this.eyeSample(marks) : null;

    if (this.calibrating) {
      // Average several frames so one glance or blink cannot define "center".
      const usable = !needEye || (eye && !eye.blinking);
      if (usable) {
        const c = this._cal;
        c.n += 1;
        c.yaw += yaw;
        c.pitch += pitch;
        if (needEye) {
          c.ex += eye.x;
          c.ey += eye.y;
          c.en += 1;
        }
        if (c.n >= this.cfg.calibrationFrames) {
          this.baseline = { yaw: c.yaw / c.n, pitch: c.pitch / c.n };
          if (c.en) this.eyeBase = { x: c.ex / c.en, y: c.ey / c.en };
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

    const s = this.cfg.sensitivity;
    let x = 0.5 + (rawX - 0.5) * s;
    let y = 0.5 + (rawY - 0.5) * s;
    if (this.cfg.mirror) x = 1 - x;

    const m = this.cfg.margin;
    x = clamp01((x - m) / (1 - 2 * m));
    y = clamp01((y - m) / (1 - 2 * m));

    const d = this.cfg.deadzone;
    if (Math.abs(x - 0.5) < d) x = 0.5;
    if (Math.abs(y - 0.5) < d) y = 0.5;
    return { x: clamp01(x), y: clamp01(y) };
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
    if (eye.blinking) return this._lastGaze || null;
    if (!this.eyeBase) this.eyeBase = { x: eye.x, y: eye.y };
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
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
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