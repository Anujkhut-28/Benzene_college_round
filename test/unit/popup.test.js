/**
 * Exercises popup.js against a minimal DOM so the state machine that decides what
 * the user is told ("calibrating", "no face", "pinch", "not connected") is verified
 * rather than assumed. The popup has no build step and no framework, so without this
 * a broken status path would only show up as a confusing popup at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const popupSource = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(ROOT, "extension", "popup.html"), "utf8");

const ids = [...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

function makeEl(id) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  return {
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    className: "",
    style: {},
    attrs,
    listeners,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
      set: classes,
    },
    addEventListener: (type, fn) => (listeners[type] = fn),
    setAttribute: (k, v) => (attrs[k] = v),
    getAttribute: (k) => attrs[k] ?? null,
    append() {},
    prepend() {},
    remove() {},
    focus() {},
  };
}

/** Boot popup.js in a sandbox and return the elements it bound. */
function boot(status) {
  const els = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
  let runtimeListener = null;
  const sent = [];

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    WeakSet,
    Set,
    Promise,
    document: {
      activeElement: null,
      getElementById: (id) => els[id] ?? null,
      createElement: () => makeEl("tmp"),
      createTextNode: () => ({}),
    },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(msg);
          return msg.type === "status" ? status : { ok: true };
        },
        onMessage: { addListener: (fn) => (runtimeListener = fn) },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(popupSource, sandbox, { filename: "popup.js" });
  return { els, emit: (m) => runtimeListener?.(m), sent };
}

const BASE = {
  ok: true,
  connected: true,
  host: "127.0.0.1",
  port: 8787,
  model: "embedded",
  tracking: true,
  listening: false,
  trackerStatus: { state: "running", face: true, calibrating: false, pinching: false, mode: "head" },
};

test("the popup tells the user when tracking is off", async () => {
  const { els } = boot({ ...BASE, tracking: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "off");
  assert.equal(els.track.textContent, "Enable tracking");
  assert.equal(els.track.attrs["aria-pressed"], "false");
  assert.equal(els.recenter.disabled, true, "re-center is meaningless while tracking is off");
  assert.match(els.status.textContent, /connected/i, "the connection line must stay truthful");
});

test("the popup guides the user through calibration", async () => {
  const { els } = boot({ ...BASE, trackerStatus: { state: "running", calibrating: true } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "calibrating");
  assert.match(els.trkHint.textContent, /straight ahead/i);
});

test("the popup reports a lost face instead of failing silently", async () => {
  const { els } = boot({ ...BASE, trackerStatus: { state: "running", face: false } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "no face");
  assert.match(els.trkHint.textContent, /frame/i, "the user needs to be told what to do about it");
});

test("the popup confirms a pinch click", async () => {
  const { els } = boot({ ...BASE, trackerStatus: { state: "running", pinching: true } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "pinch");
  assert.match(els.trkHint.textContent, /click/i);
});

test("the popup explains a tracker error rather than showing a generic failure", async () => {
  const { els } = boot({
    ...BASE,
    trackerStatus: { state: "error", message: "camera blocked: permission denied" },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "error");
  assert.match(els.trkHint.textContent, /permission denied/);
});

test("a lost connection is never masked by a healthy tracking status", async () => {
  // Regression risk: the tracking detail used to overwrite the status line, so a
  // dropped server looked fine as long as tracking was on.
  const { els } = boot({
    ...BASE,
    connected: false,
    tracking: true,
    trackerStatus: { state: "running", face: true, mode: "head" },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(els.status.textContent, /not connected/i);
  assert.equal(els.connError.hidden, false);
});

test("the popup fits within Chrome's popup height limit", async () => {
  // Chrome caps popups at 600px; content taller than that is silently cut off.
  const css = fs.readFileSync(path.join(ROOT, "extension", "popup.css"), "utf8");
  const m = css.match(/max-height:\s*(\d+)px/);
  assert.ok(m, "the popup body must declare a max-height");
  assert.ok(Number(m[1]) <= 600, `popup max-height ${m[1]}px exceeds Chrome's 600px limit`);
});

test("every control has a visible label or accessible name", () => {
  const html = popupHtml;
  // Range inputs are visually labelled by a <label for>; selects by the field <span>.
  for (const id of ["sens", "eyeSens"]) {
    assert.match(html, new RegExp(`for="${id}"`), `#${id} needs a <label for>`);
    assert.match(html, new RegExp(`id="${id}"[^>]*type="range"`), `#${id} must be a range input`);
  }
  for (const id of ["host", "port", "cmd", "mode", "clickMode"]) {
    const labelled = new RegExp(`for="${id}"`).test(html) || new RegExp(`id="${id}"[^>]*aria-label`).test(html);
    assert.ok(labelled, `#${id} needs a label or aria-label`);
  }
  // Every section heading must be referenced by its card's aria-labelledby.
  for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
    assert.match(html, new RegExp(`id="${m[1]}"`), `aria-labelledby="${m[1]}" has no matching element`);
  }
});

test("the log and help panel cannot grow the popup past the viewport", () => {
  const html = popupHtml;
  // Both are collapsible so the default height stays inside Chrome's limit.
  assert.match(html, /<details class="logwrap">/, "the log must be inside a collapsible panel");
  assert.match(html, /id="log"[^>]*aria-label/, "the log needs an accessible name");
});

test("a disconnected server tells the user how to start it", async () => {
  const { els } = boot({ ok: true, connected: false, host: "127.0.0.1", port: 8787 });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(els.status.textContent, /not connected/i);
  assert.equal(els.connError.hidden, false, "the actionable hint must be visible");
  assert.match(els.connError.textContent, /npm start/);
  assert.equal(els.listen.disabled, true, "listening is pointless without a server");
  assert.equal(els.track.disabled, true, "tracking cannot report anywhere without a server");
});

test("gaze modes are labelled as an estimate everywhere they appear", async () => {
  const { els } = boot({ ...BASE, trackerStatus: { state: "running", mode: "eye" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.trkState.textContent, "Gaze", "the pill must not claim precision it does not have");
  assert.match(popupHtml, /est\.\)/i, "the gaze option must be marked as an estimate");
  assert.match(popupHtml, /estimate direction from iris position/i);
});

test("changing a slider sends the setting to the worker", async () => {
  const { els, sent } = boot(BASE);
  await new Promise((r) => setTimeout(r, 10));
  els.sens.value = "2.2";
  els.sens.dispatchEvent?.("input");
  els.sens.listeners.input?.();
  assert.equal(els.sensOut.textContent, "2.2");
  els.sens.listeners.change();
  await new Promise((r) => setTimeout(r, 10));
  const cfg = sent.find((m) => m.type === "configure");
  assert.ok(cfg, "the worker must be told about the change");
  assert.equal(cfg.payload.sensitivity, 2.2);
});

test("live status updates keep the popup in sync", async () => {
  const { els, emit } = boot(BASE);
  await new Promise((r) => setTimeout(r, 10));
  emit({ type: "status", payload: { ...BASE, listening: true } });
  assert.equal(els.listen.textContent, "Stop listening");
  assert.equal(els.micState.textContent, "listening");

  emit({ type: "status", payload: { ...BASE, tracking: false, listening: false } });
  assert.equal(els.track.textContent, "Enable tracking");
});

test("the activity log is capped so a long session cannot grow without bound", async () => {
  const { els, emit } = boot(BASE);
  await new Promise((r) => setTimeout(r, 10));

  // Emulate what a real DOM does for prepend/removeChild so the cap can be observed.
  const kids = [];
  els.log.prepend = (node) => kids.unshift(node);
  els.log.lastElementChild = { remove: () => kids.pop() };
  Object.defineProperty(els.log, "children", { get: () => kids });

  for (let i = 0; i < 80; i++) emit({ type: "log", payload: { level: "info", msg: `entry ${i}`, t: Date.now() } });
  assert.ok(kids.length <= 40, `the log grew to ${kids.length} entries; it must be capped`);
  assert.ok(kids.length > 0, "the log must still show recent activity");
});