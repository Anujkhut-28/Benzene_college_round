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
