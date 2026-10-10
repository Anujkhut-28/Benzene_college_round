import { test } from "node:test";
import assert from "node:assert/strict";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { toDecisionQuestion, toAnswers } from "../../src/decision.js";
import { ordinalFromTranscript } from "../../src/local-jev.js";
import { findModel } from "../../src/model-path.js";

test("choice questions convert with their criteria intact", () => {
  const q = choice("Which action?", { navigate_url: { what: "Open a site" }, none: null });
  const d = toDecisionQuestion("intent", q);
  assert.equal(d.type, "choice");
  assert.equal(d.ins, "Which action?");
  assert.ok("navigate_url" in d.criteria);
  assert.ok("none" in d.criteria, "undescribed options must still be offered");
});

test("noul questions convert to a false/true pair", () => {
  const d = toDecisionQuestion("is_command", noul("Is this a command?", { true: { what: "yes" }, false: { what: "no" } }));
  assert.equal(d.type, "noul");
  assert.ok(d.criteria.false !== undefined && d.criteria.true !== undefined);
});

test("score questions convert to an ordered level list", () => {
  const d = toDecisionQuestion("scroll_amount", score("How far?", [{ what: "a little" }, { what: "one page" }]));
  assert.equal(d.type, "score");
  assert.ok(Array.isArray(d.criteria), "score levels must be a list");
  assert.match(d.criteria[0], /^level 0/);
  assert.match(d.criteria[1], /^level 1/);
});

test("answers map back onto question names, not indices", () => {
  const questions = [
    { name: "intent", type: "choice" },
    { name: "is_command", type: "noul" },
  ];
  const raw = {
    0: { type: "choice", choice: "go_back", confidence: 0.8, probabilities: { go_back: 0.8, none: 0.2 } },
    1: { type: "noul", value: 0.91 },
  };
  const out = toAnswers(["intent", "is_command"], questions, raw);
  assert.deepEqual(Object.keys(out).sort(), ["intent", "is_command"]);
  assert.equal(out.intent.choice, "go_back");
  assert.equal(out.is_command.noul, 0.91);
  assert.ok(Math.abs(out.is_command.probability_true + out.is_command.probability_false - 1) < 1e-9);
});

test("a choice answer with no explicit choice still resolves one", () => {
  const out = toAnswers(["site"], [{ name: "site", type: "choice" }], { 0: { type: "choice", probabilities: { a: 0.2, b: 0.7 } } });
  assert.equal(out.site.choice, "b", "picks the highest probability option");
});

test("ordinals are read from the transcript", () => {
  assert.equal(ordinalFromTranscript("click the first result"), 0);
  assert.equal(ordinalFromTranscript("click the third link"), 2);
  assert.equal(ordinalFromTranscript("click the last one"), -1);
  assert.equal(ordinalFromTranscript("click sign in"), null);
});

test("a decision model is discoverable without LM Studio running", () => {
  const p = findModel();
  assert.match(p, /\.gguf$/i, "findModel must return a .gguf path");
});