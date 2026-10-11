import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrackerCore } from "../../scripts/build-extension.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(ROOT, "extension");
const read = (p) => fs.readFileSync(path.join(EXT, p), "utf8");

const manifest = JSON.parse(read("manifest.json"));

test("the extension ships a valid MV3 manifest", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name, "manifest needs a name");
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "version must be three dot-separated numbers");
  assert.ok(manifest.background.service_worker, "MV3 needs a service worker");
});

test("every file the manifest references actually exists", () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((c) => c.js),
    "offscreen.html",
    "offscreen.js",
  ];
  for (const file of referenced) {
    assert.ok(fs.existsSync(path.join(EXT, file)), `${file} is referenced by the manifest but missing`);
  }
});

test("the media pipe models and wasm are vendored, so no remote code is needed", () => {
  // MV3's CSP forbids remote script. Anything loaded at runtime must be packaged.
  const vendor = path.join(EXT, "vendor");
  for (const file of ["vision_bundle.mjs", "face_landmarker.task", "hand_landmarker.task"]) {
    assert.ok(fs.existsSync(path.join(vendor, file)), `vendor/${file} is missing`);
  }
  for (const file of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) {
    assert.ok(fs.existsSync(path.join(vendor, "wasm", file)), `vendor/wasm/${file} is missing`);
  }
});

test("the CSP allows the wasm evaluation MediaPipe needs, but no remote script", () => {
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  assert.match(csp, /script-src 'self'/, "scripts must be restricted to the package");
  assert.match(csp, /wasm-unsafe-eval/, "MediaPipe compiles its wasm at runtime");
  assert.ok(!/https?:/.test(csp), "the CSP must not allow remote script sources");
});

test("the offscreen document is created for a reason Chrome accepts", () => {
  assert.ok(
    manifest.permissions.includes("offscreen"),
    "chrome.offscreen is needed to capture speech and run the landmark models",
  );
  const background = read("background.js");
  // `reasons` is plural in the API; a singular `reason` is silently ignored and the
  // document is never created, so vision silently never starts.
  assert.match(background, /reasons:\s*\["USER_MEDIA"\]/, "the creation reason must match the permission");
  assert.doesNotMatch(background, /\breason:\s*\[/, "chrome.offscreen takes `reasons`, not `reason`");
});

test("the camera and MediaPipe run in the offscreen document, not the content script", () => {
  // MV3 forbids dynamic import() in a content script (CSP) and in a service worker
  // (spec). Only an offscreen document can load the vendored MediaPipe bundle.
  const bridge = read("page-bridge.js");
  const offscreen = read("offscreen.js");
  assert.doesNotMatch(bridge, /import\(\s*chrome\.runtime\.getURL/, "the content script cannot dynamic-import");
  assert.doesNotMatch(bridge, /getUserMedia/, "the camera must not be opened in the content script");
  assert.match(offscreen, /import\(\s*chrome\.runtime\.getURL/, "the vision host loads MediaPipe");
  assert.match(offscreen, /getUserMedia/, "the vision host owns the camera");
  // The bridge must poll the host for landmarks instead of detecting locally.
  assert.match(bridge, /type:\s*"visionFrame"/);
});

test("starting tracking creates the offscreen document that hosts the camera", () => {
  const bg = read("background.js");
  const setTracking = bg.slice(bg.indexOf("async setTracking"));
  assert.match(setTracking.slice(0, 400), /ensureOffscreen\(\)/, "tracking needs the offscreen host");
});

test("only the worker opens the offscreen document, and content scripts ask it to", () => {
  // Only the service worker may call chrome.offscreen. A content script that sends
  // "visionStart" without the host existing gets "Receiving end does not exist",
  // which is exactly why the buttons used to do nothing.
  const bg = read("background.js");
  const content = read("content.js");
  const bridge = read("page-bridge.js");

  assert.match(bg, /async visionHost\(/, "the worker must expose a handler to open the host");
  assert.match(bg, /await ensureOffscreen\(\)/, "the worker must create the offscreen document");
  // Only match a real call, not a comment mentioning it.
  const callsOffscreen = /chrome\.offscreen\.(createDocument|closeDocument)\(/;
  assert.doesNotMatch(content, callsOffscreen, "content scripts must not call chrome.offscreen");
  assert.doesNotMatch(bridge, callsOffscreen, "the page bridge must not call chrome.offscreen");
  assert.match(bg, callsOffscreen, "the worker is the only place allowed to create the host");

  // The bridge must open the host before it tries to talk to it.
  const start = bridge.slice(bridge.indexOf("async start()"));
  assert.match(start.slice(0, 600), /ensureVisionHost\(\)/, "the bridge must ensure the host exists first");
  assert.ok(
    start.indexOf("ensureVisionHost()") < start.indexOf('"visionStart"'),
    "the host must be created before visionStart is sent",
  );
});

test("both Start buttons have a working path to their real capability", () => {
  // Camera: content -> worker (opens host) -> host (getUserMedia + models)
  // Voice:  popup  -> worker (opens host) -> host (SpeechRecognition)
  const bridge = read("page-bridge.js");
  const offscreen = read("offscreen.js");
  const bg = read("background.js");

  assert.match(bridge, /"visionStart"/, "the bridge must ask the host to open the camera");
  assert.match(offscreen, /visionStart/, "the host must handle visionStart");
  assert.match(offscreen, /getUserMedia/, "the host must open the camera");

  assert.match(bg, /async setListening\(/, "the worker must handle setListening");
  assert.match(bg, /async setTracking\(/, "the worker must handle setTracking");
  // Both handlers delegate to helpers that open the host; check those, not the wrappers.
  const setListeningFn = bg.slice(bg.indexOf("async function setListening"));
  assert.match(setListeningFn.slice(0, 400), /ensureOffscreen\(\)/, "listening needs the offscreen host too");
  const setTracking = bg.slice(bg.indexOf("async setTracking"));
  assert.match(setTracking.slice(0, 400), /ensureOffscreen\(\)/, "tracking needs the offscreen host");
});

test("the tracker core is generated from the shared control-page tracker", () => {
  const built = buildTrackerCore();
  assert.ok(fs.existsSync(built.path));
  const generated = read("head-tracker-core.js");
  const source = fs.readFileSync(path.join(ROOT, "src", "public", "head-tracker.js"), "utf8");

  assert.match(generated, /GENERATED FILE/, "must be marked generated so nobody edits it directly");
  assert.ok(
    !/^\s*export\s/m.test(generated),
    "MV3 content scripts are classic scripts and cannot contain `export`",
  );
  assert.match(generated, /HandsFreeHeadTracker/);
  // The maths must be the same code the control page runs, not a copy that drifts.
  for (const cls of ["class HeadTracker", "class OneEuro", "function applySmoothDeadzone"]) {
    assert.ok(source.includes(cls), `source should define ${cls}`);
    assert.ok(generated.includes(cls), `generated file should define ${cls}`);
  }
});

test("every message the popup sends has a handler in the service worker", () => {
  const popup = read("popup.js");
  const background = read("background.js");
  const sent = new Set([...popup.matchAll(/ask\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size >= 6, `expected several popup requests, saw ${[...sent]}`);
  for (const type of sent) {
    assert.match(background, new RegExp(`\\b${type}\\s*\\(`), `background.js has no handler for "${type}"`);
  }
});

test("every message the offscreen document sends has a handler in the service worker", () => {
  const offscreen = read("offscreen.js");
  const background = read("background.js");
  const sent = new Set([...offscreen.matchAll(/post\(\{\s*type:\s*"([a-zA-Z-]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size >= 3, `expected several offscreen messages, saw ${[...sent]}`);
  for (const type of sent) {
    assert.match(background, new RegExp(`\\b${type}\\s*\\(`), `background.js has no handler for "${type}"`);
  }
});

test("every command the offscreen document acts on is sent by someone", () => {
  const offscreen = read("offscreen.js");
  const background = read("background.js");
  const bridge = read("page-bridge.js");
  const senders = background + bridge;
  // Commands are the ones that mutate state. The `offscreenReady`/`offscreenError`
  // listeners only acknowledge the worker's echo of this document's own messages, so
  // they are excluded: nothing sends them, and nothing should.
  const COMMANDS = ["visionStart", "visionStop", "visionFrame", "offscreenStart", "offscreenStop"];
  for (const type of COMMANDS) {
    assert.ok(offscreen.includes(`"${type}"`), `the vision host must handle "${type}"`);
    assert.match(senders, new RegExp(`"${type}"`), `nothing sends the "${type}" command`);
  }
  // The host may announce its own state ("offscreenReady"), but must not relay a
  // message it received, or the two would echo forever.
  assert.doesNotMatch(
    offscreen,
    /if \(msg\?\.type === "offscreenError"\) \{\s*post\(/,
    "a received message must never be re-posted",
  );
  for (const type of ["offscreenReady", "offscreenError"]) {
    assert.match(background, new RegExp(`\\b${type}\\s*\\(`), `the worker must handle "${type}"`);
  }
});

test("every element id the popup binds exists in the popup markup", () => {
  const popupHtml = read("popup.html");
  const popupJs = read("popup.js");
  const declared = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...popupJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.size > 15, `expected many bound elements, saw ${used.size}`);
  for (const id of used) {
    assert.ok(declared.has(id), `popup.js binds #${id} but popup.html has no such element`);
  }
});

test("the popup only offers control modes the tracker actually understands", () => {
  // An unrecognised mode silently degrades to head tracking, so the popup must not
  // be able to store a value the tracker will ignore.
  const tracker = fs.readFileSync(path.join(ROOT, "src", "public", "head-tracker.js"), "utf8");
  const valid = ["head", "blend", "eye"];
  for (const file of ["popup.js", "content.js", "page-bridge.js"]) {
    const src = read(file);
    assert.ok(
      src.includes('["head", "blend", "eye"]'),
      `${file} should validate the tracking mode against ${valid.join("/")}`,
    );
  }
  assert.match(tracker, /mode === "head"/, "the tracker distinguishes head mode by name");
});

test("the popup exposes an eye sensitivity control that reaches the tracker", () => {
  assert.match(read("popup.html"), /id="eyeSens"/);
  // The worker forwards the whole patch rather than a fixed key list, so the setting
  // must survive the popup -> worker -> content script -> tracker path.
  assert.match(read("popup.js"), /eyeSensitivity/, "popup.js must send eyeSensitivity");
  assert.match(read("content.js"), /eyeSensitivity/, "content.js must apply eyeSensitivity");
  assert.match(read("background.js"), /async configure\(/, "the worker must forward configure patches");
  const tracker = fs.readFileSync(path.join(ROOT, "src", "public", "head-tracker.js"), "utf8");
  assert.match(tracker, /eyeSensitivity/, "the tracker must accept an eye-specific gain");
});

test("the popup does not claim the gaze modes are true eye tracking", () => {
  const html = read("popup.html");
  // The implementation estimates gaze from iris position; the UI must be honest.
  assert.match(html, /Gaze \(est\.\)/i);
  assert.match(html, /estimate direction from iris position/i);
  assert.doesNotMatch(html, /Eye tracking only/i);
});

test("every status the popup renders is one the content script can send", () => {
  const popupJs = read("popup.js");
  for (const key of ["calibrating", "face", "pinching", "state"]) {
    assert.match(popupJs, new RegExp(key), `popup.js should handle tracker status "${key}"`);
  }
  assert.match(read("background.js"), /trackerStatus/, "the worker must relay tracker status");
  assert.match(read("content.js"), /trackerStatus/, "the content script must report tracker status");
});

test("the popup cannot start a second camera while one is starting", () => {
  const js = read("popup.js");
  assert.match(js, /classList\.add\("busy"\)/, "buttons must guard against double activation");
  assert.match(js, /weakset|WeakSet|Set\(\)/i);
});

test("per-frame tracker status is not broadcast to the tab", () => {
  // Tracker status arrives every camera frame; relaying it to the tab is pure waste.
  const bg = read("background.js");
  assert.match(bg, /message\?\.type !== "tracker-status"/);
});

test("the socket payloads match the server's WebSocket protocol", () => {
  const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  const background = read("background.js");

  // Every message type the extension sends must be one the server actually handles.
  const sent = new Set([...background.matchAll(/send\(\{\s*type:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
  assert.ok(sent.size >= 4, `expected several socket messages, saw ${[...sent]}`);
  for (const type of sent) {
    assert.match(server, new RegExp(`case "${type}"`), `server.js does not handle the "${type}" message`);
  }
});