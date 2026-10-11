import { getRuntime } from "./runtime.js";

const MAX_CHUNK = Number(process.env.HANDSFREE_MAX_OPTIONS) || 24;

// Hard limits enforced by node-llama-cpp's createQuestionInputs().
const MAX_SCORE_LEVELS = 10;
const MAX_CHOICE_OPTIONS = 256;

function criteriaOf(q) {
  if (q.type === "noul") {
    // node-llama-cpp calls .trim() on both labels, so they must never be null.
    return { false: text(q.criteria?.false) ?? "No", true: text(q.criteria?.true) ?? "Yes" };
  }
  if (q.type === "score") {
    const arr = Array.isArray(q.criteria) ? q.criteria : [];
    return Object.fromEntries(arr.map((c, i) => [`level ${i}`, text(c) ?? `level ${i}`]));
  }
  return Object.fromEntries(Object.entries(q.criteria || {}).map(([k, v]) => [k, text(v)]));
}

function text(c) {
  if (c == null) return null;
  if (typeof c === "string") return c;
  const parts = [c.what, c.not_for].filter(Boolean);
  if (Array.isArray(c.examples) && c.examples.length) parts.push(`e.g. ${c.examples.slice(0, 3).join(" / ")}`);
  return parts.join(" — ") || null;
}

function instruction(q) {
  const i = q.instructions;
  if (typeof i === "string") return i;
  if (!i || typeof i !== "object") return "";
  return [i.question, i.focus].filter(Boolean).join(" ");
}

/**
 * Convert one SDK question into the shape `decide()` wants.
 *
 * node-llama-cpp's `LlamaDecisionContext.decide()` rejects the SDK's `instructions`
 * (plural) field: it reads `question.instruction` and throws
 * "Question instruction for key \"<name>\" is empty" when that is missing.
 */
export function toDecisionQuestion(name, q) {
  const ins = instruction(q);
  // An unanswerable question yields null rather than throwing. This happens legitimately
  // in normal use - "click Sign in" on a page with no elements yields a target question
  // with only the "none" option - and throwing there used to take the whole server down.
  if (!ins) return null;
  if (q.type === "noul") return { type: "noul", instruction: ins, criteria: criteriaOf(q) };
  if (q.type === "score") {
    const arr = Array.isArray(q.criteria) ? q.criteria : [];
    if (arr.length < 2 || arr.length > MAX_SCORE_LEVELS) return null;
    return {
      type: "score",
      instruction: ins,
      criteria: arr.map((c, i) => `level ${i}: ${text(c) ?? `level ${i}`}`),
    };
  }
  const crit = criteriaOf(q);
  const n = Object.keys(crit).length;
  // "choice" needs >= 2 options to be answerable at all.
  if (n < 2 || n > MAX_CHOICE_OPTIONS) return null;
  return { type: "choice", instruction: ins, criteria: crit };
}

/**
 * `decide()` keys results by the question name it was given, so map them back by name.
 * The index lookup is kept as a fallback for older/hand-rolled contexts.
 */
export function toAnswers(names, questions, raw) {
  const out = {};
  questions.forEach((q, i) => {
    const r = raw?.[q.name] ?? raw?.[String(i)] ?? raw?.[i];
    if (!r) return;
    if (q.type === "noul") {
      const value = clamp01(r.value ?? r.noul ?? 0);
      out[q.name] = { type: "noul", noul: value, probability_true: value, probability_false: 1 - value };
    } else if (q.type === "score") {
      const levels = Object.keys(criteriaOf(q)).length;
      const score = clampLevel(r.score, levels);
      out[q.name] = {
        type: "score",
        score,
        confidence: clamp01(r.confidence ?? 0),
        probabilities: r.probabilities ?? {},
      };
    } else {
      const probs = r.probabilities ?? {};
      const choice = r.choice ?? pickBest(probs) ?? "none";
      out[q.name] = {
        type: "choice",
        choice,
        confidence: clamp01(r.confidence ?? probs[choice] ?? 0),
        probabilities: probs,
      };
    }
  });
  return out;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampLevel(score, levels) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.max(0, levels - 1), Math.round(n)));
}

function pickBest(probs) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * One `decide()` call answers the whole fan-out: the model reads every verdict slot in a single
 * forward pass and returns calibrated probabilities. Questions whose option list is enormous are
 * chunked, and the chunks are merged back into one probability map.
 */
export async function decideBatch(state, questions, { context, signal } = {}) {
  const rt = context ? { context } : await getRuntime();
  const doc = typeof state === "string" ? state : JSON.stringify(state);

  // Everything that fits in one chunk goes out together, in a single forward pass.
  // Only questions whose option list overflows MAX_CHUNK get sliced, and each slice
  // forms its own group because node-llama-cpp evaluates a group as one pass.
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const [name, q] of Object.entries(questions)) {
    const keys = q.type === "choice" ? Object.keys(q.criteria || {}) : null;
    const n = keys ? keys.length : q.type === "score" ? (q.criteria?.length || 0) : 2;
    if (n <= MAX_CHUNK) {
      current.push({ ...q, name });
      continue;
    }
    flush();
    for (let i = 0; i < keys.length; i += MAX_CHUNK) {
      const slice = Object.fromEntries(keys.slice(i, i + MAX_CHUNK).map((k) => [k, q.criteria[k]]));
      groups.push([{ ...q, name, criteria: slice }]);
    }
  }
  flush();

  const merged = {};
  for (const group of groups) {
    // `decide()` takes an object keyed by question id, not an array. Questions that cannot
    // be encoded (e.g. a target question with no candidates) are dropped, not fatal.
    const payload = {};
    for (const q of group) {
      const encoded = toDecisionQuestion(q.name, q);
      if (encoded) payload[q.name] = encoded;
    }
    if (!Object.keys(payload).length) continue;
    const raw = await rt.context.decide(doc, payload, { signal });
    const names = group.map((q) => q.name);
    const partial = toAnswers(names, group, raw);
    for (const [name, ans] of Object.entries(partial)) {
      if (!merged[name]) {
        merged[name] = ans;
        continue;
      }
      if (ans.type === "choice") {
        merged[name].probabilities = { ...merged[name].probabilities, ...ans.probabilities };
        const best = pickBest(merged[name].probabilities);
        if (best) merged[name].choice = best;
        merged[name].confidence = clamp01(merged[name].probabilities[merged[name].choice] ?? merged[name].confidence);
      } else if (ans.type === "score") {
        // Chunks of the same scale: keep the strongest level seen across the slices.
        if (ans.score > merged[name].score) merged[name].score = ans.score;
        merged[name].probabilities = { ...merged[name].probabilities, ...ans.probabilities };
      }
    }
  }
  return merged;
}