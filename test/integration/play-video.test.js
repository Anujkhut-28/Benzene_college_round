import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { execute } from "../../src/executor.js";

const CSS = `<style>
  ytd-app, ytd-masthead, ytd-mini-guide-renderer, ytd-guide-renderer, tp-yt-app-drawer,
  ytd-popup-container, ytd-mini-player, ytd-rich-grid-renderer, ytd-rich-item-renderer { display: block; }
</style>`;

const PAGE = `<body>${CSS}
  <ytd-app>
    <div id="masthead">
      <a href="/watch?v=logo" title="Logo">Logo</a>
      <a href="/watch?v=banner" title="Banner ad">Banner ad</a>
    </div>
    <ytd-mini-guide-renderer>
      <a href="/watch?v=trending1" title="Trending in nav">Trending in nav</a>
    </ytd-mini-guide-renderer>
    <tp-yt-app-drawer>
      <a href="/watch?v=drawer1" title="Drawer video">Drawer video</a>
    </tp-yt-app-drawer>
    <ytd-rich-grid-renderer id="contents">
      <ytd-rich-item-renderer>
        <a id="thumbnail" href="/watch?v=v1" title="Cat one">t</a>
        <a id="video-title-link" href="/watch?v=v1" title="Cat one">Cat one</a>
        <a href="/channel/cat">Cat channel</a>
      </ytd-rich-item-renderer>
      <ytd-rich-item-renderer>
        <a id="thumbnail" href="/watch?v=v2" title="Cat two">t</a>
        <a id="video-title-link" href="/watch?v=v2" title="Cat two">Cat two</a>
      </ytd-rich-item-renderer>
      <ytd-rich-item-renderer>
        <a id="thumbnail" href="/watch?v=v3" title="Cat three">t</a>
        <a id="video-title-link" href="/watch?v=v3" title="Cat three">Cat three</a>
      </ytd-rich-item-renderer>
      <ytd-rich-item-renderer>
        <a id="thumbnail" href="/shorts/s1" title="Short one">t</a>
        <a id="video-title-link" href="/shorts/s1" title="Short one">Short one</a>
      </ytd-rich-item-renderer>
    </ytd-rich-grid-renderer>
  </ytd-app>
</body>`;

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: PAGE }));
  await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
});

after(async () => {
  await browser?.close();
});

const browserStub = () => ({
  ensurePage: async () => page,
  overlay: async () => {},
  pages: [page],
  page,
});

async function pick(index) {
  const before = page.url();
  const res = await execute({ type: "play_video", index, label: `play video ${index + 1}` }, browserStub());
  return { res, moved: page.url() !== before, at: page.url() };
}

test("plays the Nth video on the page, skipping chrome and duplicate links", async () => {
  for (const [index, expected] of [[0, "Cat one"], [1, "Cat two"], [2, "Cat three"], [3, "Short one"]]) {
    const { res } = await pick(index);
    assert.equal(res.ok, true, `video ${index + 1} should play`);
    assert.equal(res.detail, expected, `video ${index + 1} should be "${expected}"`);
  }
});

test("'last' takes the final video", async () => {
  const { res } = await pick(-1);
  assert.equal(res.ok, true);
  assert.equal(res.detail, "Short one");
});

test("an out-of-range position says how many videos there are, and clicks nothing", async () => {
  const { res, moved } = await pick(99);
  assert.equal(res.ok, false);
  assert.match(res.detail, /only 4 videos/);
  assert.equal(moved, false, "a failed pick must not navigate anywhere");
});