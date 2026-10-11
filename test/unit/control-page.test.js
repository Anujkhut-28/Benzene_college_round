/**
 * Guards the control page: the inline module must parse, and every id the script
 * reaches for must exist in the markup. A typo in either fails silently at runtime
 * because the page has no build step and no test runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "src", "public", "index.html"), "utf8");

const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "index.html should contain an inline module script");
const script = scriptMatch[1];

test("the control page's inline module parses", () => {
  // Strip the bare import, which node --check cannot resolve outside a bundler.
  const body = script.replace(/^\s*import .*$/gm, "");
  assert.doesNotThrow(
    () => new Function(body),
    "the inline script must be syntactically valid JavaScript",
  );
});

test("every element id the script uses exists in the markup", () => {
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.size > 20, `expected many bound elements, saw ${used.size}`);
  for (const id of used) {
    assert.ok(declared.has(id), `the script binds #${id} but the markup has no such element`);
  }
});

test("values interpolated into innerHTML are escaped", () => {
  // Element role/id come from the page being controlled and must never be injected raw.
  assert.match(script, /\$\{esc\(e\.id\)\}/, "e.id must be escaped");
  assert.match(script, /\$\{esc\(e\.role\)\}/, "e.role must be escaped");
  assert.match(script, /\$\{esc\(r\.name\)\}/, "policy reason names must be escaped");
});

test("the transcript, verdict and pending messages are announced to screen readers", () => {
  for (const id of ["transcript", "verdict", "pending"]) {
    const re = new RegExp(`id="${id}"[^>]*aria-live="polite"`);
    assert.match(html, re, `#${id} should be a polite live region`);
  }
  assert.match(html, /id="micerror"[^>]*role="alert"/, "mic errors should be announced assertively");
});

test("form controls are labelled", () => {
  // The sensitivity slider and both selects need real labels, not just nearby text.
  for (const id of ["headmode", "headclick", "headsens"]) {
    assert.match(html, new RegExp(`for="${id}"`), `#${id} needs a <label for>`);
  }
  assert.match(html, /id="cmd"[^>]*(aria-label|placeholder)/);
});

test("interactive elements are real buttons, not clickable divs", () => {
  assert.ok(!/<div[^>]*onclick=/i.test(html), "use <button> rather than a div with onclick");
});

test("the page explains itself when speech is unavailable", () => {
  assert.match(script, /micError\(/, "the mic path must surface an in-page error");
  assert.ok(!/alert\(/.test(script), "a modal alert is not reachable or screen-reader friendly");
});

test("reduced-motion preferences are respected", () => {
  assert.match(html, /prefers-reduced-motion/, "animations must be opt-out");
});

test("the log is not a live region, so it cannot flood a screen reader", () => {
  assert.match(html, /id="log"[^>]*aria-live="off"/, "a busy log must not be announced on every line");
});

test("the websocket client reconnects with backoff instead of once a second forever", () => {
  assert.match(script, /reconnectDelay/, "reconnect must be backed off");
  assert.match(script, /Math\.min\(reconnectDelay \* 2, 10000\)/, "backoff must be capped");
  assert.match(script, /ws\.onerror/, "a socket error should close and trigger the reconnect path");
});