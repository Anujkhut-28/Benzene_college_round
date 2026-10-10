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
