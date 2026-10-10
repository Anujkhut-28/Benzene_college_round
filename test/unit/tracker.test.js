import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadTracker } from "../../src/public/head-tracker.js";

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
