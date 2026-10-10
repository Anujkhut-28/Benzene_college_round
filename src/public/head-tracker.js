/**
 * Hands-free pointer: webcam EYE tracking drives the cursor, dwell-to-click activates.
 * Runs entirely in the browser on the control page and forwards synthetic pointer events
 * into the controlled page over the existing WebSocket.
 *
 * Eyes beat the head for pointing because the head is far coarser: you cannot reach the screen
 * corners by turning your neck without also turning your whole body, and holding a fixed pose
 * for 900 ms is uncomfortable. Eye direction is precise, and it needs no head movement at all.
 * Iris landmarks are read when the model provides them (478-point output); otherwise we fall
 * back to head pose so the feature degrades instead of breaking.
 */

const DEFAULTS = {
  enabled: false,
  mode: "eye",
  sensitivity: 1.0,
  smoothing: 0.15,
  dwellMs: 900,
  margin: 0.1,
  deadzone: 0.005,
  dwellMove: 0.04,
  mirror: true,
  showVideo: true,
  clickMode: "pinch",
  pinchOn: 0.25,
  pinchOff: 0.35,
};

const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const NOSE = 1;
const L_CHEEK = 234;
const R_CHEEK = 454;
const TOP = 10;

const EYE_GAIN_X = 8.5;
const EYE_GAIN_Y = 14.0;
const HEAD_GAIN_X = 6.0;
const HEAD_GAIN_Y = 7.0;

export class HeadTracker {
  constructor({ video, canvas, onStatus, onPoint, onActivate }) {
    this.video = video;
    this.canvas = canvas;
    this.onStatus = onStatus || (() => {});
    this.onPoint = onPoint || (() => {});
    this.onActivate = onActivate || (() => {});
    this.cfg = { ...DEFAULTS };
    this.landmarker = null;
    this.running = false;
    this.raf = 0;
    this.point = { x: 0.5, y: 0.5 };
    this.smooth = { x: 0.5, y: 0.5 };
    this.dwellStart = 0;
    this.dwellAnchor = { x: 0.5, y: 0.5 };
    this.calibrating = true;
    this.baseline = null;
    this.eyeBase = null;
    this.faceSeenSince = 0;
    this.pinched = false;
    this.pinchWasDown = false;
    this.handLandmarker = null;
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
    this.onStatus({ state: "running" });
    if (this.cfg.clickMode !== "dwell") await this.loadHands();
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

  /**
   * True while thumb and index are pinched. Normalised by hand size so the threshold holds at
   * any distance from the camera, with hysteresis so a trembling hand cannot chatter clicks.
   */
  pinching(hand) {
    if (!hand || hand.length < 21) return false;
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
    this.onStatus({ state: "stopped" });
  }

  recalibrate() {
    this.calibrating = true;
    this.baseline = null;
    this.eyeBase = null;
    this.smooth = { x: 0.5, y: 0.5 };
    this.point = { x: 0.5, y: 0.5 };
  }

  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const v = this.video;
    if (!v || v.readyState < 2 || !this.landmarker) return;

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
      this.faceSeenSince = performance.now();
      this.onStatus({ state: "running", face: false });
      this.draw(null);
      return;
    }

    const p = this.compute(marks);
    if (!p) return;
    this.smooth.x += (p.x - this.smooth.x) * (1 - this.cfg.smoothing);
    this.smooth.y += (p.y - this.smooth.y) * (1 - this.cfg.smoothing);
    this.point = { x: this.smooth.x, y: this.smooth.y };
    this.draw(marks);
    this.onPoint(this.point);

    const pinch = this.cfg.clickMode !== "dwell" && this.handLandmarker ? this.detectPinch(v) : false;
    if (this.cfg.clickMode !== "dwell") {
      if (pinch && !this.pinchWasDown) this.onActivate({ dwelling: false, progress: 0, click: { ...this.point }, pinch: true });
      this.pinchWasDown = pinch;
    }
    if (this.cfg.clickMode !== "pinch") this.tickDwell();
    this.onStatus({ state: "running", face: true, calibrating: this.calibrating, pinching: pinch });
  }

  detectPinch(v) {
    if (!this.handLandmarker) return false;
    try {
      const now = performance.now();
      const ts = now <= (this._lastHandTime || 0) ? (this._lastHandTime || 0) + 1 : now;
      this._lastHandTime = ts;
      const r = this.handLandmarker.detectForVideo(v, ts);
      const hand = r?.landmarks?.[0];
      return this.pinching(hand);
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

    const gaze = this.cfg.mode === "head" ? null : this.eyeGaze(marks);

    if (this.calibrating) {
      this.baseline = { yaw, pitch };
      if (gaze) {
        const left = irisOffset(marks, L_IRIS, 33, 133, 159, 145);
        const right = irisOffset(marks, R_IRIS, 362, 263, 386, 374);
        if (left && right) this.eyeBase = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
      }
      this.calibrating = false;
      return { x: 0.5, y: 0.5 };
    }

    let rawX;
    let rawY;
    if (gaze && this.cfg.mode === "eye") {
      rawX = gaze.x;
      rawY = gaze.y;
    } else if (gaze) {
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

  eyeGaze(marks) {
    if (!marks || marks.length < 478) return null;
    const left = irisOffset(marks, L_IRIS, 33, 133, 159, 145);
    const right = irisOffset(marks, R_IRIS, 362, 263, 386, 374);
    if (!left || !right) return null;

    const rawX = (left.x + right.x) / 2;
    const rawY = (left.y + right.y) / 2;

    if (!this.eyeBase) {
      this.eyeBase = { x: rawX, y: rawY };
    }
    return {
      x: 0.5 + (rawX - this.eyeBase.x) * EYE_GAIN_X,
      y: 0.5 + (rawY - this.eyeBase.y) * EYE_GAIN_Y,
    };
  }

  tickDwell() {
    if (!this.cfg.enabled) return;
    const now = performance.now();

    if (this.dwellStart) {
      const dx = Math.abs(this.point.x - this.dwellAnchor.x);
      const dy = Math.abs(this.point.y - this.dwellAnchor.y);
      if (Math.hypot(dx, dy) > this.cfg.dwellMove) {
        this.dwellStart = 0;
        this.onActivate({ dwelling: false, progress: 0 });
      }
    }

    if (!this.dwellStart) {
      this.dwellStart = now;
      this.dwellAnchor = { ...this.point };
      this.onActivate({ dwelling: true, progress: 0 });
      return;
    }
    const held = now - this.dwellStart;
    if (held >= this.cfg.dwellMs) {
      this.dwellStart = 0;
      this.onActivate({ dwelling: false, progress: 0, click: { ...this.point } });
      return;
    }
    this.onActivate({ dwelling: true, progress: held / this.cfg.dwellMs });
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
      if (marks.length >= 478) {
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

/**
 * Iris centre relative to one eye, normalised by that eye's own width and height so the
 * result is independent of face size and distance. Horizontal is the solid signal; vertical is
 * much weaker (the eye barely moves up/down), so the caller amplifies it separately.
 * Returns null if any landmark is missing.
 */
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
  const w = b.x - a.x;
  if (Math.abs(w) < 1e-4) return null;

  // Vertical span from the eyelids; fall back to the corner midpoint when unavailable.
  const top = marks[lidTop];
  const bottom = marks[lidBottom];
  const midY = (a.y + b.y) / 2;
  const yTop = top ? top.y : midY - 0.01;
  const yBottom = bottom ? bottom.y : midY + 0.01;
  const h = Math.abs(yBottom - yTop);
  return {
    x: (sx / n - a.x) / w,
    y: h > 1e-4 ? (sy / n - yTop) / (yBottom - yTop) : 0.5,
  };
}