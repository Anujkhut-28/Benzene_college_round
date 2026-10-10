import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTextCandidates, extractUrlCandidates, normalizeSpokenUrl, parseCandidatePick, toHttpUrl } from "../../src/spans.js";

test("text candidates: 'type X into the search box' offers the bare payload first", () => {
  const c = extractTextCandidates("type hello world into the search box");
  assert.equal(c[0], "hello world");
  assert.ok(c.includes("hello world into the search box"));
  assert.ok(c.includes("type hello world into the search box"), "whole transcript is always a fallback");
});

test("text candidates: 'search for X' and 'look up X'", () => {
  assert.equal(extractTextCandidates("search for jev typesafe")[0], "jev typesafe");
  assert.equal(extractTextCandidates("look up alan turing please")[0], "alan turing");
  assert.equal(extractTextCandidates("search wikipedia for cats")[0], "cats");
  assert.equal(extractTextCandidates("google cheap flights to lisbon")[0], "cheap flights to lisbon");
});

test("text candidates: quoted spans win", () => {
  assert.equal(extractTextCandidates('type "good morning" in the comment box')[0], "good morning");
});

test("text candidates: empty / no verbs", () => {
  assert.deepEqual(extractTextCandidates(""), []);
  const c = extractTextCandidates("scroll down");
  assert.ok(c.includes("scroll down"));
  assert.ok(c.length <= 8);
});

test("text candidates are unique and capped", () => {
  const c = extractTextCandidates("search for search for search for a b c d e f g h i j");
  assert.equal(new Set(c.map((s) => s.toLowerCase())).size, c.length);
  assert.ok(c.length <= 8);
});

test("spoken URLs: 'example dot com' -> example.com", () => {
  assert.equal(normalizeSpokenUrl("go to example dot com"), "go to example.com");
  assert.deepEqual(extractUrlCandidates("go to example dot com"), ["example.com"]);
  assert.deepEqual(extractUrlCandidates("open news dot ycombinator dot com please"), ["news.ycombinator.com"]);
  assert.deepEqual(extractUrlCandidates("visit https://docs.typesafe.ai/models"), ["https://docs.typesafe.ai/models"]);
  assert.deepEqual(extractUrlCandidates("scroll down a bit"), []);
});

test("toHttpUrl adds https", () => {
  assert.equal(toHttpUrl("example.com"), "https://example.com");
  assert.equal(toHttpUrl("http://a.b"), "http://a.b");
});

test("candidate pick parsing", () => {
  assert.equal(parseCandidatePick("two"), 2);
  assert.equal(parseCandidatePick("the second one"), 2);
  assert.equal(parseCandidatePick("number 3"), 3);
  assert.equal(parseCandidatePick("click the first one"), 1);
  assert.equal(parseCandidatePick("one"), 1);
  assert.equal(parseCandidatePick("four", 3), null, "out of range");
  assert.equal(parseCandidatePick("go to wikipedia"), null);
  assert.equal(parseCandidatePick(""), null);
});

test("candidate picks work past five, which is where numbered overlays actually live", () => {
  // "show numbers" badges up to 60 elements, so picking has to reach past five.
  for (const n of [6, 9, 14, 23, 47, 60]) {
    assert.equal(parseCandidatePick(`click ${n}`, 60), n, `"click ${n}" should pick ${n}`);
    assert.equal(parseCandidatePick(String(n), 60), n);
  }
  // Digits must win outright, or "click 14" is read as "one, then four".
  assert.equal(parseCandidatePick("click 14", 60), 14);
  // Speech says "twenty three"; the recognizer does not produce "23".
  assert.equal(parseCandidatePick("click twenty three", 60), 23);
  assert.equal(parseCandidatePick("twenty three", 60), 23);
  assert.equal(parseCandidatePick("fifty five", 60), 55);
  assert.equal(parseCandidatePick("the 30th", 60), 30);
  assert.equal(parseCandidatePick("click the ninth", 60), 9);
  // Out of range and non-numbers stay unpicked.
  assert.equal(parseCandidatePick("click 61", 60), null);
  assert.equal(parseCandidatePick("click 9", 5), null);
  assert.equal(parseCandidatePick("click the sign in button", 60), null);
  assert.equal(parseCandidatePick("0", 60), null);
});
