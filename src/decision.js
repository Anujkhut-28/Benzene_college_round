import { getRuntime } from "./runtime.js";

const MAX_CHUNK = Number(process.env.HANDSFREE_MAX_OPTIONS) || 24;

function criteriaOf(q) {
  if (q.type === "noul") {
    return { false: text(q.criteria?.false), true: text(q.criteria?.true) };
  }
  if (q.type === "score") {
    const arr = Array.isArray(q.criteria) ? q.criteria : [];
    return Object.fromEntries(arr.map((c, i) => [`level ${i}`, text(c)]));
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

/** Convert one SDK question into the shape `decide()` wants. */
export function toDecisionQuestion(name, q) {
  const ins = instruction(q);
  if (q.type === "noul") return { type: "noul", ins, criteria: criteriaOf(q) };
  if (q.type === "score") {
    const arr = Array.isArray(q.criteria) ? q.criteria : [];
    return {
      type: "score",
      ins,
      criteria: arr.map((c, i) => `level ${i}: ${text(c) ?? `level ${i}`}`),
    };
  }
  const crit = criteriaOf(q);
  return { type: "choice", ins, criteria: crit };
}

/** `decide()` keys results by index; map them back onto question names. */
export function toAnswers(names, questions, raw) {
  const out = {};
  questions.forEach((q, i) => {
    const r = raw[String(i)] ?? raw[i];
    if (!r) return;
    if (q.type === "noul") {
      out[q.name] = { type: "noul", noul: r.value, probability_true: r.value, probability_false: 1 - r.value };
    } else if (q.type === "score") {
      const levels = Object.keys(criteriaOf(q));
      const level = Math.max(0, Math.min(levels.length - 1, r.score ?? 1));
      out[q.name] = { type: "score", score: level, probabilities: r.probabilities ?? {} };
    } else {
      const probs = r.probabilities ?? {};
      const choice = r.choice ?? Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
      out[q.name] = { type: "choice", choice, confidence: r.confidence ?? probs[choice] ?? 0, probabilities: probs };
    }
  });
  return out;
}

/**
 * One `decide()` call answers the whole fan-out: the model reads every verdict slot in a single
 * forward pass and returns calibrated probabilities. Questions whose option list is enormous are
 * chunked, and the chunks are merged back into one probability map.
 */
export async function decideBatch(state, questions) {
  const rt = await getRuntime();
  const doc = typeof state === "string" ? state : JSON.stringify(state);

  const groups = [];
  for (const [name, q] of Object.entries(questions)) {
    const n = q.type === "choice" ? Object.keys(q.criteria || {}).length : q.type === "score" ? (q.criteria?.length || 0) : 2;
    if (n <= MAX_CHUNK) groups.push([{ ...q, name }]);
    else {
      const keys = Object.keys(q.criteria);
      for (let i = 0; i < keys.length; i += MAX_CHUNK) {
        const slice = Object.fromEntries(keys.slice(i, i + MAX_CHUNK).map((k) => [k, q.criteria[k]]));
        groups.push([{ ...q, name, criteria: slice }]);
      }
    }
  }

  const merged = {};
  for (const group of groups) {
    const payload = group.map((q) => toDecisionQuestion(q.name, q));
    const raw = await rt.context.decide(doc, payload);
    const names = group.map((q) => q.name);
    const partial = toAnswers(names, group, raw);
    for (const [name, ans] of Object.entries(partial)) {
      if (!merged[name]) {
        merged[name] = ans;
        continue;
      }
      if (ans.type === "choice") {
        merged[name].probabilities = { ...merged[name].probabilities, ...ans.probabilities };
        const best = Object.entries(merged[name].probabilities).sort((a, b) => b[1] - a[1])[0];
        merged[name].choice = best?.[0];
        merged[name].confidence = best?.[1] ?? 0;
      }
    }
  }
  return merged;
}