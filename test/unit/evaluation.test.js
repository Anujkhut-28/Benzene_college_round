import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvaluationStore, dictationAccuracy } from "../../src/evaluation.js";

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "handsfree-eval-"));
  return path.join(dir, "eval.json");
}

test("evaluation records a repeatable run with automatic action stats and manual marks", async () => {
  let now = 1000;
  const store = new EvaluationStore({ filePath: await tempFile(), now: () => now });
  await store.load();
  await store.start({ taskId: "nav-search-click", inputMethod: "handsfree" });
  await store.recordDecision({ transcript: "go to wikipedia", policy: { decision: "act", action: { type: "navigate_url" } } });
  await store.recordAction({ action: { type: "navigate_url" }, ok: true, via: "jev", detail: "ok" });
  await store.mark({ command: "correct" });
  await store.mark({ command: "incorrect", selectionError: true, accidentalActivation: true });
  await store.mark({ dictationExpected: "hello world", dictationActual: "hello word" });
  now = 3500;
  const snap = await store.finish({ success: true });

  assert.equal(snap.summary.finishedCount, 1);
  assert.equal(snap.runs[0].durationMs, 2500);
  assert.equal(snap.runs[0].stats.commandAccuracy, 50);
  assert.equal(snap.runs[0].stats.selectionErrors, 1);
  assert.equal(snap.runs[0].stats.accidentalActivations, 1);
  assert.ok(snap.runs[0].stats.dictationAccuracy < 100);
  assert.equal(snap.summary.byMethod[0].inputMethod, "handsfree");
});

test("evaluation compares input methods without fabricating manual metrics", async () => {
  let now = 0;
  const store = new EvaluationStore({ filePath: await tempFile(), now: () => now });
  await store.start({ inputMethod: "handsfree" });
  now = 1000;
  await store.finish({ success: true });
  await store.start({ inputMethod: "mouse_keyboard" });
  now = 2500;
  const snap = await store.finish({ success: false });

  assert.equal(snap.summary.byMethod.length, 2);
  assert.equal(snap.summary.byMethod.find((x) => x.inputMethod === "handsfree").avgTaskCompletionMs, 1000);
  assert.equal(snap.summary.byMethod.find((x) => x.inputMethod === "mouse_keyboard").avgTaskCompletionMs, 1500);
  assert.equal(snap.summary.byMethod.find((x) => x.inputMethod === "handsfree").avgCommandAccuracy, null);
});

test("dictationAccuracy returns null without expected text", () => {
  assert.equal(dictationAccuracy("", "anything"), null);
  assert.equal(dictationAccuracy("abc", "abc"), 100);
  assert.equal(dictationAccuracy("abc", "axc"), 66.67);
});
