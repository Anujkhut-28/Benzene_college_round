import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadTracker, OneEuro, applySmoothDeadzone, trimmedMean } from "../../src/public/head-tracker.js";

function makeFace({ noseX = 0.5, noseY = 0.5, cheekL = 0.35, cheekR = 0.65 } = {}) {
  const marks = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  marks[1] = { x: noseX, y: noseY, z: 0 };
  marks[234] = { x: cheekL, y: 0.5, z: 0 };
  marks[454] = { x: cheekR, y: 0.5, z: 0 };
  return marks;
}

function makeHand(thumbDist = 0.04) {
  const hand = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  hand[0] = { x: 0.5, y: 0.7, z: 0 };
  hand[9] = { x: 0.5, y: 0.5, z: 0 };
  hand[4] = { x: 0.5, y: 0.4, z: 0 };
  hand[8] = { x: 0.5, y: 0.4 + thumbDist, z: 0 };
  return hand;
}

test("head tracker: neutral pose calibrates to center", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head" });
  const face = makeFace();
  const p1 = tracker.compute(face);
  assert.equal(p1.x, 0.5);
  assert.equal(p1.y, 0.5);
  assert.equal(tracker.calibrating, false);
});

test("head tracker: yaw moves horizontal position", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", mirror: true });
  tracker.compute(makeFace());
  const turnedRight = tracker.compute(makeFace({ noseX: 0.46 }));
  assert.ok(turnedRight.x > 0.5);
  const turnedLeft = tracker.compute(makeFace({ noseX: 0.54 }));
  assert.ok(turnedLeft.x < 0.5);
});

test("head tracker: pitch moves vertical position", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head" });
  tracker.compute(makeFace());
  const tiltedDown = tracker.compute(makeFace({ noseY: 0.54 }));
  assert.ok(tiltedDown.y > 0.5);
  const tiltedUp = tracker.compute(makeFace({ noseY: 0.46 }));
  assert.ok(tiltedUp.y < 0.5);
});

test("head tracker: sensitivity scales around center", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", sensitivity: 2.0 });
  const p = tracker.compute(makeFace());
  assert.equal(p.x, 0.5);
  assert.equal(p.y, 0.5);
});

test("head tracker: pinch activates and releases", () => {
  const tracker = new HeadTracker({});
  const touching = makeHand(0.03);
  assert.equal(tracker.pinching(touching), true);
  const separated = makeHand(0.12);
  assert.equal(tracker.pinching(separated), false);
});

test("head tracker: a single-frame landmark spike never reaches the cursor", () => {
  // Regression: the old fixed per-frame jump allowance was wide enough that one bad
  // landmark frame could throw the cursor across most of the screen.
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
  tracker.processFrame(makeFace(), 1000);
  for (let i = 1; i <= 5; i++) tracker.processFrame(makeFace({ noseX: 0.52 }), 1000 + i * 33);

  // A genuine single-frame glitch: one corrupted landmark frame surrounded by good ones.
  // Measured as the cursor's displacement *caused by the glitch frame*, not its
  // distance from centre, so ordinary convergence is not counted as jitter.
  let worstJump = 0;
  let prev = { x: tracker.point.x, y: tracker.point.y };
  for (let i = 0; i < 40; i++) {
    const glitched = i % 7 === 3;
    const r = tracker.processFrame(
      glitched ? makeFace({ noseX: 0.05, noseY: 0.95 }) : makeFace({ noseX: 0.52 }),
      1200 + i * 33,
    );
    if (glitched) worstJump = Math.max(worstJump, Math.hypot(r.point.x - prev.x, r.point.y - prev.y));
    prev = { x: r.point.x, y: r.point.y };
  }
  assert.ok(worstJump < 0.1, `a single-frame glitch displaced the cursor by ${worstJump.toFixed(3)}`);
});

test("head tracker: low frame rates are not artificially slowed by the speed limit", () => {
  // The limit is expressed per second, so the same head movement over the same
  // elapsed time must land in roughly the same place regardless of frame rate.
  const run = (fps, seconds) => {
    const dt = 1000 / fps;
    const tracker = new HeadTracker({});
    tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
    tracker.processFrame(makeFace(), 1000);
    const steps = Math.round(fps * seconds);
    let last = null;
    for (let i = 1; i <= steps; i++) {
      last = tracker.processFrame(makeFace({ noseX: 0.5 + (i / steps) * 0.1 }), 1000 + i * dt);
    }
    return last.point.x;
  };
  const slow = run(15, 0.2); // 3 frames
  const mid = run(30, 0.2); // 6 frames
  const fast = run(60, 0.2); // 12 frames
  // Every rate should respond; none should be pinned near the start.
  for (const [label, v] of [["15", slow], ["30", mid], ["60", fast]]) {
    assert.ok(v > 0.55, `at ${label} fps the cursor only reached ${v.toFixed(2)}`);
  }
});

test("head tracker: returning after a long absence recalibrates instead of jumping", () => {
  // Regression: the old baseline described where the user was before they left, so
  // coming back threw the cursor to a stale, meaningless position.
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
  tracker.processFrame(makeFace(), 1000);
  for (let i = 1; i <= 5; i++) tracker.processFrame(makeFace({ noseX: 0.6 }), 1000 + i * 33);

  // Out of frame for 5 seconds, then back in a noticeably different posture.
  for (let i = 0; i < 15; i++) tracker.processFrame(null, 1200 + i * 33 * 5);
  const back = tracker.processFrame(makeFace({ noseX: 0.58 }), 1200 + 15 * 33 * 5);

  assert.ok(back.recalibrating || back.calibrating, "a long absence must trigger recalibration");
  // Recalibration re-centres the cursor: the crucial part is that it does NOT stay
  // pinned to the stale pre-absence position (0.6) or fly off to a corner.
  assert.ok(Math.abs(back.point.x - 0.5) < 0.1, `cursor landed at ${back.point.x.toFixed(2)} on return`);
});

test("head tracker: a brief dropout does not force a recalibration", () => {
  // Losing a frame or two is ordinary tracking noise and must not cost the user their
  // calibration, or the cursor drifts on every blink-sized hiccup.
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
  tracker.processFrame(makeFace(), 1000);
  for (let i = 1; i <= 12; i++) tracker.processFrame(makeFace({ noseX: 0.6 }), 1000 + i * 33);
  // Let the filter settle so the comparison measures the dropout, not convergence lag.
  const before = tracker.point.x;
  for (let i = 1; i <= 2; i++) tracker.processFrame(null, 1400 + i * 33);
  const back = tracker.processFrame(makeFace({ noseX: 0.6 }), 1500);
  assert.ok(!back.recalibrating, "a two-frame dropout must not recalibrate");
  assert.ok(
    Math.abs(back.point.x - before) < 0.05,
    `cursor jumped from ${before.toFixed(2)} to ${back.point.x.toFixed(2)} across a dropout`,
  );
});

test("head tracker: a lost frame reports how long the user has been gone", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1 });
  tracker.processFrame(makeFace(), 1000);
  tracker.processFrame(null, 1100);
  const r = tracker.processFrame(null, 1500);
  assert.equal(r.face, false);
  assert.ok(r.lostForMs >= 400, `expected lostForMs ~500, got ${r.lostForMs}`);
});

test("head tracker: non-finite landmarks are treated as tracking loss, not a crash", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1 });
  tracker.processFrame(makeFace(), 1000);
  const broken = makeFace();
  broken[1] = { x: NaN, y: 0.5, z: 0 };
  let r;
  assert.doesNotThrow(() => {
    r = tracker.processFrame(broken, 1033);
    r = tracker.processFrame(makeFace(), 1066);
  });
  assert.ok(Number.isFinite(r.point.x), "the cursor must remain a finite coordinate");
});

test("head tracker: the dead zone can be tuned per axis", () => {
  // Vertical head motion is noisier than horizontal, so one shared threshold either
  // jitters vertically or feels sluggish horizontally.
  const mk = (cfg) => {
    const t = new HeadTracker({});
    t.update({ mode: "head", calibrationFrames: 1, mirror: false, ...cfg });
    t.processFrame(makeFace(), 1000);
    let mx = 0, my = 0;
    // Tremor large enough for the dead zone to matter but well short of a real move.
    for (let i = 1; i <= 60; i++) {
      const wobble = Math.sin(i) * 0.004;
      const r = t.processFrame(makeFace({ noseX: 0.5 + wobble, noseY: 0.5 + wobble * 1.3 }), 1000 + i * 33);
      mx = Math.max(mx, Math.abs(r.point.x - 0.5));
      my = Math.max(my, Math.abs(r.point.y - 0.5));
    }
    return { mx, my };
  };
  const same = mk({ deadzone: 0.008 });
  const split = mk({ deadzone: 0.008, deadzoneY: 0.03 });
  assert.ok(split.my < same.my, `a wider Y dead zone must reduce vertical jitter (${split.my} vs ${same.my})`);
  assert.ok(split.mx <= same.mx + 1e-9, "a Y-only dead zone must not disturb X");
});

test("hand tracker: a dropped hand frame does not fire a phantom second click", () => {
  // Regression: a single frame with no hand used to clear the pinch latch, so a hand
  // that reappeared still closed counted as a brand new pinch, double-clicking.
  const tracker = new HeadTracker({});
  let clicks = 0;
  let wasDown = false;
  const feed = (hand) => {
    const down = tracker.pinching(hand);
    if (down && !wasDown) clicks += 1;
    wasDown = down;
  };

  feed(makeHand(0.03));
  assert.equal(clicks, 1, "the initial pinch is one click");

  // One or two dropped frames: the tracker is still working, the hand is just occluded.
  feed(null);
  feed(null);
  feed(makeHand(0.03));
  assert.equal(clicks, 1, "a brief dropout must not re-trigger the click");

  // A sustained absence really was a release, so pinching again is a new click.
  feed(null);
  feed(null);
  feed(null);
  feed(makeHand(0.03));
  assert.equal(clicks, 2, "a sustained dropout releases the pinch");
});

test("hand tracker: pinch normalises by hand size so distance from camera does not matter", () => {
  const near = new HeadTracker({});
  const far = new HeadTracker({});
  const touching = makeHand(0.03);
  assert.equal(near.pinching(touching), true);

  // Same pose, rendered at half the scale: the normalised gap must be unchanged.
  const scaled = makeHand(0.015).map((p) => ({ x: 0.5 + (p.x - 0.5) / 2, y: 0.5 + (p.y - 0.5) / 2, z: 0 }));
  assert.equal(far.pinching(scaled), true, "a pinch is a pinch whether you are near or far");
});

test("head tracker: switching to pinch mode after start loads the hand model", () => {
  // Regression: the hand model was only ever loaded from start(), so choosing
  // "Pinch" once tracking was already running left pinch-to-click silently dead.
  const tracker = new HeadTracker({});
  tracker.running = true;
  tracker.handLandmarker = null;
  let loaded = 0;
  tracker.loadHands = async () => {
    loaded += 1;
    tracker.handLandmarker = { detectForVideo: () => ({ landmarks: [] }) };
    return { ok: true };
  };

  tracker.update({ clickMode: "none" });
  assert.equal(loaded, 0, "no hand model while pinch is off");

  tracker.update({ clickMode: "pinch" });
  return new Promise((resolve) =>
    setImmediate(() => {
      assert.equal(loaded, 1, "switching to pinch must load the hand model");
      assert.ok(tracker.handLandmarker);
      resolve();
    }),
  );
});

function makeFaceWithEyes({ irisOffsetDx = 0, lidClosed = false } = {}) {
  const marks = makeFace();
  marks[33] = { x: 0.35, y: 0.45, z: 0 };
  marks[133] = { x: 0.45, y: 0.45, z: 0 };
  marks[159] = { x: 0.40, y: lidClosed ? 0.45 : 0.42, z: 0 };
  marks[145] = { x: 0.40, y: lidClosed ? 0.45 : 0.48, z: 0 };
  for (let i = 468; i <= 472; i++) {
    marks[i] = { x: 0.40 + irisOffsetDx, y: 0.45, z: 0 };
  }
  marks[362] = { x: 0.55, y: 0.45, z: 0 };
  marks[263] = { x: 0.65, y: 0.45, z: 0 };
  marks[386] = { x: 0.60, y: lidClosed ? 0.45 : 0.42, z: 0 };
  marks[374] = { x: 0.60, y: lidClosed ? 0.45 : 0.48, z: 0 };
  for (let i = 473; i <= 477; i++) {
    marks[i] = { x: 0.60 + irisOffsetDx, y: 0.45, z: 0 };
  }
  return marks;
}

test("eye tracker: iris shift moves gaze horizontally", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "eye", mirror: true });
  const center = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0 }));
  assert.equal(center.x, 0.5);

  const lookRight = tracker.compute(makeFaceWithEyes({ irisOffsetDx: -0.02 }));
  assert.ok(lookRight.x > 0.5);

  const lookLeft = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0.02 }));
  assert.ok(lookLeft.x < 0.5);
});

test("eye tracker: blink maintains stable gaze without exploding", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "eye" });
  tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0 }));
  const openGaze = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0.01 }));

  const blinkingGaze = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0.01, lidClosed: true }));
  assert.ok(Math.abs(blinkingGaze.y - openGaze.y) < 0.05);
});

test("eye tracker: an implausible iris jump is treated as a dropout, not a flick", () => {
  // A lost iris landmark makes the eye sample jump far outside any real gaze range.
  // Without a guard the cursor snaps to the screen edge and the user has to recover.
  const tracker = new HeadTracker({});
  tracker.update({ mode: "eye" });
  tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0 }));
  const settled = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 0.01 }));
  const wild = tracker.compute(makeFaceWithEyes({ irisOffsetDx: 3 }));
  assert.ok(Number.isFinite(wild.x), "the cursor must stay finite");
  assert.ok(Math.abs(wild.x - settled.x) < 0.5, `an iris dropout flung the cursor to ${wild.x.toFixed(2)}`);
});

test("eye tracker: eye sensitivity scales eye modes without touching head mode", () => {
  const gazeAt = (cfg, dx) => {
    const t = new HeadTracker({});
    t.update({ mode: "eye", mirror: false, ...cfg });
    t.compute(makeFaceWithEyes({ irisOffsetDx: 0 }));
    return t.compute(makeFaceWithEyes({ irisOffsetDx: dx })).x;
  };
  // The synthetic eye spans a ~0.1 wide aperture, so usable iris travel is a few
  // thousandths of normalised image width before gaze saturates at the edge.
  const base = gazeAt({}, 0.002);
  const damped = gazeAt({ eyeSensitivity: 0.4 }, 0.002);
  assert.ok(damped < base, `lowering eye sensitivity must reduce travel (${damped.toFixed(2)} vs ${base.toFixed(2)})`);

  // Head-only mode must ignore eyeSensitivity entirely.
  const headAt = (cfg) => {
    const t = new HeadTracker({});
    t.update({ mode: "head", mirror: false, ...cfg });
    t.compute(makeFace({ noseX: 0.5 }));
    return t.compute(makeFace({ noseX: 0.56 })).x;
  };
  assert.equal(headAt({}), headAt({ eyeSensitivity: 0.2 }), "head mode must not be affected by eye gain");
});

test("eye tracker: eye modes suppress micro-movement better than head mode", () => {
  // Tiny involuntary eye motion is the main source of twitchy cursor control.
  const jitterAt = (mode) => {
    const t = new HeadTracker({});
    t.update({ mode, mirror: false, eyeMedian: 1 });
    t.compute(makeFaceWithEyes({ irisOffsetDx: 0 }));
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      const dx = Math.sin(i) * 0.00015;
      const p = t.compute(makeFaceWithEyes({ irisOffsetDx: dx }));
      worst = Math.max(worst, Math.abs(p.x - 0.5));
    }
    return worst;
  };
  assert.ok(
    jitterAt("eye") <= jitterAt("head") + 1e-9,
    "eye mode should be no twitchier than head mode",
  );
});

test("diagnostics do not overstate what the eye tracking can do", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "eye" });
  const d = tracker.getDiagnostics();
  assert.equal(d.gazeIsEstimated, true, "the UI must be told gaze is an estimate, not a measurement");
});

test("gesture: a single noisy pinch frame does not click", () => {
  // One bad landmark frame must never reach the page as a click.
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);
  tracker.updateGesture(true, 1000);
  assert.equal(clicks, 0, "one frame of pinch is not a gesture");
  tracker.updateGesture(true, 1033);
  assert.equal(clicks, 1, "two consecutive frames is a deliberate pinch");
});

test("gesture: holding the pinch steady never fires a second click", () => {
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);
  let t = 1000;
  // A user holding the gesture, with small landmark wobble, for three seconds.
  for (let i = 0; i < 90; i++) {
    tracker.updateGesture(true, t);
    t += 33;
  }
  assert.equal(clicks, 1, `holding the pinch fired ${clicks} clicks`);
});

test("gesture: a new pinch is allowed after the hand opens and the cooldown passes", () => {
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);

  let t = 1000;
  tracker.updateGesture(true, t);
  tracker.updateGesture(true, (t += 33));
  assert.equal(clicks, 1);

  // Hand opens and stays open long enough to rearm.
  for (let i = 0; i < 10; i++) tracker.updateGesture(false, (t += 33));
  // And the cooldown has elapsed.
  tracker.updateGesture(true, (t += 600));
  tracker.updateGesture(true, (t += 33));
  assert.equal(clicks, 2, "a deliberate second pinch must register");
});

test("gesture: a brief re-close inside the cooldown does not click again", () => {
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);
  let t = 1000;
  tracker.updateGesture(true, t);
  tracker.updateGesture(true, (t += 33));
  assert.equal(clicks, 1);

  // A momentary gap in detection, then the hand is still closed.
  for (let i = 0; i < 2; i++) tracker.updateGesture(false, (t += 33));
  tracker.updateGesture(true, t += 33);
  tracker.updateGesture(true, (t += 33));
  assert.equal(clicks, 1, "hand still closed must not click again");
});

test("gesture: losing the face mid-gesture cancels it without clicking on return", () => {
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);
  tracker.updateGesture(true, 1000);
  // Face lost: the caller drops the in-progress run.
  tracker._pinchRun = 0;
  tracker.updateGesture(true, 1100);
  assert.equal(clicks, 0, "a pinch interrupted by face loss must not fire on reacquisition");
});

test("gesture: restart clears the cooldown so the first pinch works immediately", () => {
  const tracker = new HeadTracker({});
  let clicks = 0;
  tracker.onActivate = () => (clicks += 1);
  tracker.updateGesture(true, 1000);
  tracker.updateGesture(true, 1033);
  assert.equal(clicks, 1);

  tracker.stop(); // camera stopped
  tracker.running = true;
  tracker.handLandmarker = { detectForVideo: () => ({ landmarks: [] }) };
  // Immediately after restart the user pinches again.
  tracker.updateGesture(true, 1100);
  tracker.updateGesture(true, 1133);
  assert.equal(clicks, 2, "a restart must not leave the gesture stuck in cooldown");
});

test("smooth deadzone: provides continuous C0 transition with no edge jumps", () => {
  const dz = 0.01;
  // Inside deadzone -> strictly center
  assert.equal(applySmoothDeadzone(0.500, 0.5, dz), 0.5);
  assert.equal(applySmoothDeadzone(0.505, 0.5, dz), 0.5);
  assert.equal(applySmoothDeadzone(0.495, 0.5, dz), 0.5);

  // Exact boundary -> continuous 0.5
  assert.equal(applySmoothDeadzone(0.510, 0.5, dz), 0.5);

  // Just outside boundary -> smooth small delta, no discontinuous jump
  const justOutside = applySmoothDeadzone(0.511, 0.5, dz);
  assert.ok(justOutside > 0.5);
  assert.ok(justOutside - 0.5 < 0.005, "No boundary cliff");

  // Far outside -> scales smoothly toward full range
  const far = applySmoothDeadzone(1.0, 0.5, dz);
  assert.equal(far, 1.0);
});

test("trimmedMean: eliminates extreme outliers during calibration", () => {
  // 5 frames with 1 extreme twitch at the end
  const samples = [0.01, 0.01, 0.02, 0.01, 0.80];
  const tm = trimmedMean(samples, 0.2); // discards min (0.01) and max (0.80)
  assert.ok(tm < 0.03, `Expected trimmed mean < 0.03, got ${tm}`);
});

test("pipeline: holding head still for several seconds keeps cursor rock-solid", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1 });
  tracker.processFrame(makeFace(), 1000); // calibrate

  let maxDriftX = 0;
  let maxDriftY = 0;
  // Simulate 90 frames (3 seconds at 30 fps) with realistic resting webcam sensor noise
  for (let i = 1; i <= 90; i++) {
    const jitter = (Math.sin(i) * 0.0004);
    const res = tracker.processFrame(makeFace({ noseX: 0.5 + jitter, noseY: 0.5 + jitter }), 1000 + i * 33);
    maxDriftX = Math.max(maxDriftX, Math.abs(res.point.x - 0.5));
    maxDriftY = Math.max(maxDriftY, Math.abs(res.point.y - 0.5));
  }
  // Deadzone and OneEuro filter suppress micro-jitter completely
  assert.ok(maxDriftX < 0.002, `Max X drift was ${maxDriftX}`);
  assert.ok(maxDriftY < 0.002, `Max Y drift was ${maxDriftY}`);
});

test("pipeline: fast intentional movement tracks responsively", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
  tracker.processFrame(makeFace(), 1000); // calibrate

  // Move right over 150ms
  let finalPoint = null;
  for (let i = 1; i <= 5; i++) {
    const r = tracker.processFrame(makeFace({ noseX: 0.5 + i * 0.02 }), 1000 + i * 30);
    finalPoint = r.point;
  }
  assert.ok(finalPoint.x > 0.65, "Fast movement responds promptly");
});

test("pipeline: single-frame tracking glitch is clamped", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1 });
  tracker.processFrame(makeFace(), 1000); // calibrate
  tracker.processFrame(makeFace(), 1033);

  // Single glitch frame jumps wildly
  const glitch = tracker.processFrame(makeFace({ noseX: 0.1, noseY: 0.9 }), 1066);
  // Cursor should NOT jump to corner in one frame
  assert.ok(Math.abs(glitch.point.x - 0.5) < 0.15, "Glitch X clamped");
  assert.ok(Math.abs(glitch.point.y - 0.5) < 0.15, "Glitch Y clamped");

  // Next normal frame resumes smoothly
  const normal = tracker.processFrame(makeFace(), 1099);
  assert.ok(Math.abs(normal.point.x - 0.5) < 0.05);
});

test("pipeline: face loss freezes cursor and reacquisition restores smoothly", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1, mirror: false });
  tracker.processFrame(makeFace(), 1000);
  // Move to a distinct position
  for (let i = 1; i <= 5; i++) {
    tracker.processFrame(makeFace({ noseX: 0.54 }), 1000 + i * 33);
  }
  const frozenX = tracker.point.x;
  assert.ok(frozenX > 0.55);

  // Face lost for 3 frames (user looked away / obscured)
  const lost1 = tracker.processFrame(null, 1200);
  assert.equal(lost1.face, false);
  assert.equal(tracker.point.x, frozenX, "Cursor freezes at last position when face lost");

  tracker.processFrame(null, 1233);
  tracker.processFrame(null, 1266);
  assert.equal(tracker.point.x, frozenX);

  // Face returns: reacquisition frame warms up without leaping across screen
  const reac1 = tracker.processFrame(makeFace({ noseX: 0.54 }), 1300);
  assert.equal(reac1.face, true);
  assert.ok(Math.abs(tracker.point.x - frozenX) < 0.02, "No jump on reacquisition");
});

test("pipeline: variable frame rates behave consistently", () => {
  const tracker60 = new HeadTracker({});
  tracker60.update({ mode: "head", calibrationFrames: 1 });
  tracker60.processFrame(makeFace(), 1000);

  const tracker30 = new HeadTracker({});
  tracker30.update({ mode: "head", calibrationFrames: 1 });
  tracker30.processFrame(makeFace(), 1000);

  // Step at 60 fps for 100ms
  let p60 = null;
  for (let i = 1; i <= 6; i++) {
    p60 = tracker60.processFrame(makeFace({ noseX: 0.52 }), 1000 + i * 16.6).point;
  }

  // Step at 30 fps for 100ms
  let p30 = null;
  for (let i = 1; i <= 3; i++) {
    p30 = tracker30.processFrame(makeFace({ noseX: 0.52 }), 1000 + i * 33.3).point;
  }

  // Both should reach comparable filtered positions
  assert.ok(Math.abs(p60.x - p30.x) < 0.08, `60fps (${p60.x}) and 30fps (${p30.x}) agree`);
});

test("pipeline: diagnostics exposes tracking state", () => {
  const tracker = new HeadTracker({});
  tracker.update({ mode: "head", calibrationFrames: 1 });
  tracker.processFrame(makeFace(), 1000);
  const diag = tracker.getDiagnostics();
  assert.equal(typeof diag.calibrating, "boolean");
  assert.ok(diag.baseline);
  assert.equal(typeof diag.filteredPoint.x, "number");
  assert.equal(typeof diag.filter.x, "number");
});
