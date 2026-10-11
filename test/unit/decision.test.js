import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { toDecisionQuestion, toAnswers, decideBatch } from "../../src/decision.js";
import { ordinalFromTranscript } from "../../src/local-jev.js";
import { findModel } from "../../src/model-path.js";

test("choice questions convert with their criteria intact", () => {
  const q = choice("Which action?", { navigate_url: { what: "Open a site" }, none: null });
  const d = toDecisionQuestion("intent", q);
  assert.equal(d.type, "choice");
  assert.equal(d.instruction, "Which action?", "node-llama-cpp reads `instruction`, not `ins`");
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
  // decide() returns answers keyed by question name.
  const raw = {
    intent: { type: "choice", choice: "go_back", confidence: 0.8, probabilities: { go_back: 0.8, none: 0.2 } },
    is_command: { type: "noul", value: 0.91 },
  };
  const out = toAnswers(["intent", "is_command"], questions, raw);
  assert.deepEqual(Object.keys(out).sort(), ["intent", "is_command"]);
  assert.equal(out.intent.choice, "go_back");
  assert.equal(out.is_command.noul, 0.91);
  assert.ok(Math.abs(out.is_command.probability_true + out.is_command.probability_false - 1) < 1e-9);
});

test("every question carries the fields node-llama-cpp's createQuestionInputs reads", () => {
  // Regression: the payload used to carry `ins` instead of `instruction`, which made
  // node-llama-cpp throw 'Question instruction for key "<name>" is empty'.
  // Mirrors the checks in node-llama-cpp/dist/evaluator/LlamaDecisionContext/utils/createQuestionInputs.js
  const built = {
    intent: toDecisionQuestion("intent", choice("Which action?", { navigate_url: { what: "Open a site" }, none: null })),
    is_command: toDecisionQuestion("is_command", noul("Is this a command?", { true: { what: "yes" }, false: { what: "no" } })),
    scroll_amount: toDecisionQuestion("scroll_amount", score("How far?", [{ what: "a little" }, { what: "one page" }])),
  };
  for (const [name, q] of Object.entries(built)) {
    assert.equal(typeof q.instruction, "string", `${name} needs instruction`);
    assert.notEqual(q.instruction.length, 0, `${name} instruction must not be empty`);
    assert.ok(!("ins" in q), `${name} must not use the SDK's "ins"`);
  }
  assert.ok(Object.keys(built.intent.criteria).length >= 2);
  assert.equal(typeof built.is_command.criteria.true, "string");
  assert.equal(typeof built.is_command.criteria.false, "string");
  assert.ok(Array.isArray(built.scroll_amount.criteria));
});

test("decideBatch passes decide() a keyed object and reads answers back by name", async () => {
  const seen = [];
  const fakeContext = {
    async decide(doc, questions) {
      seen.push(questions);
      // Real decide() keys answers by question name and returns no indices.
      return Object.fromEntries(
        Object.entries(questions).map(([name, q]) =>
          q.type === "choice"
            ? [name, { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.7, probabilities: { [Object.keys(q.criteria)[0]]: 0.7 } }]
            : [name, { type: "noul", value: 0.5 }],
        ),
      );
    },
  };
  const answers = await decideBatch(
    { transcript: "open wikipedia" },
    {
      intent: choice("Which action?", { navigate_url: { what: "Navigate" }, none: null }),
      is_command: noul("Is this a command?", { true: { what: "yes" }, false: { what: "no" } }),
    },
    { context: fakeContext },
  );

  assert.ok(!Array.isArray(seen[0]), "decide() needs an object keyed by question id, not an array");
  assert.deepEqual(Object.keys(seen[0]).sort(), ["intent", "is_command"]);
  assert.equal(seen.length, 1, "questions that fit in one chunk must share a single forward pass");
  assert.equal(answers.intent.choice, "navigate_url");
  assert.equal(answers.is_command.noul, 0.5);
});

test("questions node-llama-cpp cannot encode are dropped, not thrown", () => {
  // Regression: these all occur in normal use ("click Sign in" on a page with no
  // elements), and throwing took the entire server down mid-session.
  assert.equal(toDecisionQuestion("solo", choice("Pick", { only: null })), null, "needs >= 2 options");
  assert.equal(toDecisionQuestion("bad", { type: "choice", instructions: "", criteria: { a: null, b: null } }), null, "needs an instruction");
  assert.equal(toDecisionQuestion("big", score("How far?", Array.from({ length: 11 }, (_, i) => ({ what: `l${i}` })))), null, "score max is 10 levels");
});

test("a dropped question does not prevent the others from being answered", async () => {
  const seen = [];
  const ctx = {
    async decide(doc, questions) {
      seen.push(Object.keys(questions));
      return Object.fromEntries(Object.entries(questions).map(([n]) => [n, { type: "choice", choice: "none", confidence: 0.5, probabilities: { none: 0.5 } }]));
    },
  };
  const answers = await decideBatch(
    { transcript: "click sign in" },
    {
      // Unanswerable: only the "none" option exists.
      target: choice("Which element?", { none: null }),
      intent: choice("Which action?", { navigate_url: { what: "Navigate" }, none: null }),
    },
    { context: ctx },
  );
  assert.deepEqual(seen[0], ["intent"], "the unanswerable question is omitted from the call");
  assert.ok(answers.intent, "the answerable question still returns a result");
  assert.equal(answers.target, undefined, "no answer is invented for the dropped question");
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

test("model discovery finds a gguf in a search root without LM Studio running", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-model-"));
  try {
    // Nested, and not named like the bundled default: this must be found by extension.
    mkdirSync(path.join(root, "publisher"), { recursive: true });
    const nested = path.join(root, "publisher", "Jev-Style-0.8B-Decision-v3-Q8_0.gguf");
    writeFileSync(nested, "gguf");
    const p = findModel({ roots: [root], env: {} });
    assert.match(p, /\.gguf$/i, "findModel must return a .gguf path");
    assert.equal(p, nested);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model discovery prefers the named decision model over any other gguf", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-model-"));
  try {
    writeFileSync(path.join(root, "some-other-model-Q4_K_M.gguf"), "gguf");
    writeFileSync(path.join(root, "Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf"), "gguf");
    assert.match(findModel({ roots: [root], env: {} }), /Jev-Style-0\.8B-Decision-v3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model discovery reports where it looked when nothing is found", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-model-"));
  try {
    assert.throws(() => findModel({ roots: [root], env: {} }), (err) => {
      assert.match(err.message, /No decision model found/);
      assert.match(err.message, /HANDSFREE_MODEL/);
      assert.ok(err.message.includes(root), "the error must name the directories searched");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});