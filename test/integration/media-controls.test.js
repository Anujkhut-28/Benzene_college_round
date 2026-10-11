import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { execute } from "../../src/executor.js";

const WATCH = `<body>
  <ytd-player>
    <div id="movie_player">
      <video id="player" width="320" height="180"></video>
      <button class="ytp-large-play-button" aria-label="Play (k)">overlay</button>
      <button class="ytp-play-button" aria-label="Pause (k)">bar</button>
      <button class="xt">Play all</button>
    </div>
  </ytd-player>
  <div id="below"><button id="other">Something else</button></div>
</body>`;

const SPOTIFY = `<body>
  <div id="tracklist">
    <button aria-label="Play Song A">row play</button>
    <button aria-label="Play Song B">row play</button>
  </div>
  <div id="now">
    <button aria-label="Previous">Prev</button>
    <button aria-label="Pause (k)">Pause</button>
    <button aria-label="Play">Play</button>
    <button aria-label="Next">Next</button>
    <button aria-label="Mute">Mute</button>
    <input type="range" aria-label="Volume" min="0" max="100" step="5" value="50">
  </div>
</body>`;

let browser;
let yt;
let sp;

const stub = (page) => ({ ensurePage: async () => page, overlay: async () => {}, pages: [page], page });
const run = (page, op) => execute({ type: "media", op, label: `media ${op}` }, stub(page));

before(async () => {
  browser = await chromium.launch();

  yt = await browser.newPage();
  await yt.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: WATCH }));
  await yt.goto("https://www.youtube.com/watch?v=abc", { waitUntil: "domcontentloaded" });
  await yt.evaluate(() => {
    window.__calls = [];
    window.__paused = false;
    const v = document.querySelector("video");
    Object.defineProperty(v, "paused", { configurable: true, get: () => window.__paused });
    v.pause = () => {
      window.__calls.push("pause");
      window.__paused = true;
    };
    v.play = () => {
      window.__calls.push("play");
      window.__paused = false;
      return Promise.resolve();
    };
  });
  await yt.evaluate(() => {
    window.__btn = [];
    for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => window.__btn.push(b.className || b.id));
  });

  sp = await browser.newPage();
  await sp.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SPOTIFY }));
  await sp.goto("https://open.spotify.com/", { waitUntil: "domcontentloaded" });
  await sp.evaluate(() => {
    window.__clicks = [];
    for (const b of document.querySelectorAll("button")) {
      b.addEventListener("click", () => window.__clicks.push(b.getAttribute("aria-label")));
    }
  });
});

after(async () => {
  await browser?.close();
});

test("a bare pause falls through to the video element when there is no pause button", async () => {
  const res = await run(yt, "pause");
  assert.equal(res.ok, true);
  assert.match(res.detail, /video/);
  assert.deepEqual(await yt.evaluate(() => window.__calls), ["pause"]);
});

test("a resume plays the video element again", async () => {
  await run(yt, "pause");
  const res = await run(yt, "play");
  assert.equal(res.ok, true);
  assert.match(res.detail, /playing/);
  assert.deepEqual(await yt.evaluate(() => window.__calls), ["pause", "pause", "play"]);
});

test("the video element wins over YouTube's many 'Play'-labelled buttons", async () => {
  assert.deepEqual(
    await yt.evaluate(() => window.__btn),
    [],
    "no Play/Pause button should be clicked when a video element exists",
  );
});

test("a resume that does not take effect is reported, not claimed as done", async () => {
  const dead = await browser.newPage();
  await dead.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<body><video></video></body>` }));
  await dead.goto("https://example.com/x", { waitUntil: "domcontentloaded" });
  await dead.evaluate(() => {
    const v = document.querySelector("video");
    v.play = () => new Promise(() => {});
    Object.defineProperty(v, "paused", { configurable: true, get: () => true });
  });
  const res = await run(dead, "play");
  assert.equal(res.ok, false);
  assert.match(res.detail, /did not take effect/);
  await dead.close();
});

test("Spotify-style labelled buttons are clicked, not the video element", async () => {
  for (const [op, expected] of [["pause", "Pause (k)"], ["next", "Next"], ["previous", "Previous"], ["mute", "Mute"]]) {
    const res = await run(sp, op);
    assert.equal(res.ok, true, `${op} should find a control`);
    assert.match(res.detail, /button/, `${op} should use the button`);
    assert.equal(res.detail.toLowerCase().includes(expected.toLowerCase()), true, `${op} should hit "${expected}"`);
  }
  assert.deepEqual(await sp.evaluate(() => window.__clicks), ["Pause (k)", "Next", "Previous", "Mute"]);
});

test("the main transport button wins over the per-track play buttons", async () => {
  const res = await run(sp, "play");
  assert.equal(res.ok, true);
  const last = await sp.evaluate(() => window.__clicks[window.__clicks.length - 1]);
  assert.equal(last, "Play", "must be the bare 'Play' control, not 'Play Song A'");
});

test("volume moves the slider instead of clicking a button", async () => {
  const before = await sp.evaluate(() => document.querySelector('input[type=range]').value);
  const up = await run(sp, "volume_up");
  assert.equal(up.ok, true);
  assert.match(up.detail, /slider/);
  const after = await sp.evaluate(() => document.querySelector('input[type=range]').value);
  assert.equal(Number(after), Number(before) + 5);

  await run(sp, "volume_down");
  assert.equal(Number(await sp.evaluate(() => document.querySelector('input[type=range]').value)), Number(before));

  assert.deepEqual(await sp.evaluate(() => window.__clicks), ["Pause (k)", "Next", "Previous", "Mute", "Play"]);
});

test("an unsupported control fails loudly instead of clicking something arbitrary", async () => {
  const res = await run(yt, "next");
  assert.equal(res.ok, false);
  assert.match(res.detail, /no next control/);
});