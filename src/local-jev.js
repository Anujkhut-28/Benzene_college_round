import { buildRequest } from "./jev.js";
import { recognize } from "./rules.js";
import { decideBatch } from "./decision.js";
import { TARGET_INTENTS } from "./constants.js";
import { runtimeState } from "./runtime.js";

export const MODEL_LABEL = "Jev-Style-0.8B-Decision-v3 (embedded)";

const AMBIGUOUS_MAX = Number(process.env.HANDSFREE_AMBIGUOUS) || 0.45;

const ORDINAL_WORDS = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  sixth: 5,
  "6th": 5,
  last: -1,
  final: -1,
};

export function ordinalFromTranscript(transcript) {
  const said = String(transcript || "").toLowerCase();
  for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(said)) return idx;
  }
  return null;
}

const MAX_TARGET = Number(process.env.HANDSFREE_MAX_TARGET) || 8;

/** The single element whose visible text is exactly the spoken name, or null. */
function exactHintMatch(elements, hint) {
  const want = String(hint || "").toLowerCase().trim();
  if (!want || !Array.isArray(elements)) return null;
  const hits = elements.filter((el) => {
    const t = (el?.text || "").trim().toLowerCase();
    const p = (el?.placeholder || "").trim().toLowerCase();
    return t === want || p === want;
  });
  return hits.length === 1 ? hits[0].id : null;
}

function shortlistTarget(questions, state, elements) {
  const q = questions.target;
  if (!q) return questions;
  const keys = Object.keys(q.criteria || {});
  if (keys.length <= MAX_TARGET + 1) return questions;

  // `state.elements` holds the encoded one-line strings; shortlisting needs the real objects,
  // so they are passed in from the snapshot.
  if (!Array.isArray(elements)) return questions;

  const ids = keys.filter((k) => k !== "none");
  const ordinal = ordinalFromTranscript(state.transcript);

  let keep;
  if (ordinal !== null) {
    const pick = ordinal === -1 ? ids[ids.length - 1] : ids[ordinal];
    keep = pick ? [pick] : ids.slice(0, MAX_TARGET);
  } else {
    const words = new Set(
      String(state.transcript || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
    const hint = String(state.element_hint || "").toLowerCase().trim();

    keep = ids
      .map((key) => {
        const el = elements.find((e) => e.id === key);
        const label = `${el?.role || ""} ${el?.text || ""} ${el?.placeholder || ""}`.toLowerCase();
        let score = 0;
        for (const w of label.split(/[^a-z0-9]+/)) if (words.has(w)) score += 1;
        if (hint && label.includes(hint)) score += 3;
        return { key, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TARGET)
      .map((x) => x.key);
  }

  const kept = new Set([...keep, "none"]);
  return { ...questions, target: { ...q, criteria: Object.fromEntries(keys.filter((k) => kept.has(k)).map((k) => [k, q.criteria[k]])) } };
}

function decideConstant(name, value, reason) {
  return { decision: "act", summary: reason || `${name}`, constant: name, value };
}

/** Resolve an ordinal command to a single element without asking the model. */
function resolveOrdinal(state, ruled, elements) {
  if (ruled.ordinal === undefined) return null;
  const ids = elements.map((e) => e.id);
  if (!ids.length) return null;
  const pick = ruled.ordinal === -1 ? ids[ids.length - 1] : ids[ruled.ordinal];
  if (!pick) return null;
  const el = elements.find((e) => e.id === pick);
  return { targetId: pick, label: `${el?.role || ""} "${el?.text || el?.placeholder || ""}"`.trim() };
}

export async function decide(input, { signal } = {}) {
  const { state, questions, candidates } = buildRequest(input);
  const t0 = performance.now();

  const ruled = recognize(state?.transcript, { site: state?.page?.site });
  const needsTarget = ruled && TARGET_INTENTS.has(ruled.intent.choice);

  if (ruled && !needsTarget) {
    return {
      answers: ruled,
      latencyMs: Math.round(performance.now() - t0),
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      model: MODEL_LABEL,
      requestId: null,
      candidates,
      state,
      questionCount: 0,
      viaRules: true,
    };
  }

  const promptState = ruled ? { ...state, element_hint: ruled.element_hint } : state;
  const snapshotElements = input?.snapshot?.elements || [];

  // "click shorts" when exactly one visible element is called "Shorts": the user named it, so
  // there is nothing to disambiguate. Answered here instead of asking the model to pick.
  const exact = exactHintMatch(snapshotElements, promptState.element_hint);
  if (exact) {
    return {
      answers: {
        ...ruled,
        target: { type: "choice", choice: exact, confidence: 0.9, probabilities: { [exact]: 0.9, none: 0.1 } },
      },
      latencyMs: Math.round(performance.now() - t0),
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      model: MODEL_LABEL,
      requestId: null,
      candidates,
      state,
      questionCount: 0,
      viaRules: true,
    };
  }

  const asked = shortlistTarget(questions, promptState, snapshotElements);
  const skip = ruled ? Object.keys(ruled).filter((k) => k in asked) : [];
  const subset = Object.fromEntries(Object.entries(asked).filter(([k]) => !skip.includes(k)));

  const modelAnswers = Object.keys(subset).length ? await decideBatch(promptState, subset, { signal }) : {};
  const answers = ruled ? { ...ruled, ...modelAnswers } : modelAnswers;

  if (ruled && ruled.ordinal !== undefined && answers.target?.choice) {
    const hit = resolveOrdinal(promptState, ruled, snapshotElements);
    if (hit && hit.targetId === answers.target.choice) {
      answers.target = { ...answers.target, confidence: 0.9, probabilities: { [hit.targetId]: 0.9, none: 0.1 } };
    }
  }

  return {
    answers,
    latencyMs: Math.round(performance.now() - t0),
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    model: MODEL_LABEL,
    requestId: null,
    candidates,
    state,
    questionCount: Object.keys(subset).length,
    device: runtimeState().device,
  };
}

export { getRuntime, runtimeState } from "./runtime.js";
export { ping, status } from "./doctor.js";