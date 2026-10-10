/**
 * Execution policy: pure code that turns Jev's answers into ACT / WAIT / IGNORE / CONFIRM /
 * DISAMBIGUATE. Every gate is a number from constants.js so the UI can show WHY.
 */
import {
  T,
  TARGET_INTENTS,
  SITE_HOME,
  SITE_PATHS,
  SITE_SEARCH,
  DEFAULT_SEARCH_ENGINE,
  SILENCE_COMPLETE_MS,
  PAYLOAD_SILENCE_MS,
  PAYLOAD_INTENTS,
  isDestructiveElement,
} from "./constants.js";
import { toHttpUrl, extractPathCandidates } from "./spans.js";

const r2 = (x) => Math.round(x * 100) / 100;

function check(reasons, name, value, threshold, pass, note) {
  reasons.push({ name, value: typeof value === "number" ? r2(value) : value, threshold, pass, note });
  return pass;
}

/** Top-N choice options by probability, excluding `none`. */
export function topChoices(choiceAnswer, n = 3) {
  if (!choiceAnswer?.probabilities) return [];
  return Object.entries(choiceAnswer.probabilities)
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p: r2(p) }));
}

function pickSpan(answer, minConfidence, fallback) {
  if (!answer) return fallback ?? null;
  if (answer.choice === "none") return null;
  if (answer.confidence < minConfidence) return fallback ?? answer.choice;
  return answer.choice;
}

/**
 * Resolve a spoken page name inside a named site ("open shorts" -> youtube.com/shorts/).
 * The site must be known, so "open shorts" while on any page still goes to YouTube Shorts,
 * but "open some random thing" still waits instead of guessing a URL.
 */
function pickSitePath(site, pathCandidates) {
  const paths = SITE_PATHS[site];
  if (!paths || !Array.isArray(pathCandidates) || !pathCandidates.length) return null;
  // Longest candidate first so "my channel" wins over "my".
  const ordered = [...pathCandidates].sort((a, b) => b.length - a.length);
  for (const cand of ordered) {
    // Tolerate a leading article: "my history" resolves the "history" page.
    const key = String(cand).toLowerCase().trim().replace(/^(?:the|my)\s+/, "");
    const url = paths[key] || paths[String(cand).toLowerCase().trim()];
    if (url) return { url, label: `${site} ${key}` };
  }
  return null;
}

function fillTemplate(tpl, q) {
  return tpl.replace("%s", encodeURIComponent(q));
}

/**
 * @param {object} p
 * @param {object} p.answers   Jev answers (intent, target, site, complete, is_command, destructive, scroll_amount, text_span?, url_span?, tab_direction)
 * @param {object} p.candidates {text: string[], url: string[]}
 * @param {object} p.snapshot  current page snapshot (elements, searchBoxId, site, url)
 * @param {number} p.silentMs  ms since the transcript last changed
 * @param {boolean} p.isFinal  the speech recognizer marked this utterance final
 * @param {object|null} p.pending  a pending destructive action awaiting "confirm"
 * @param {boolean} p.confirmed  user already said confirm for this action
 * @returns {{decision: string, action?: object, candidates?: Array, reasons: Array, summary: string}}
 */
export function evaluatePolicy({ answers, candidates, snapshot, silentMs = 0, isFinal = false, pending = null, context = null }) {
  const reasons = [];
  const intent = answers.intent;
  const intentName = intent?.choice ?? "none";
  const lastAction = context?.recentActions?.length ? context.recentActions[context.recentActions.length - 1] : null;
  const correction = answers.is_correction?.noul ?? 0;
  // A correction only counts once the phrase is finished (or the user has gone quiet): a one-word
  // partial like "go" right after a scroll must not be read as "undo the scroll".
  const finishedPhrase = (answers.complete?.noul ?? 0) >= T.complete || silentMs >= SILENCE_COMPLETE_MS || isFinal;
  // Reversing the previous action IS an action on the browser, so a correction must clear the same
  // "is the user talking to the browser at all" bar as any other command. Without this, chit-chat
  // that happens to contain a negation ("so anyway I think we should not get lunch") reads as a
  // correction and undoes a real navigation.
  const isCmdEarly = (answers.is_command?.noul ?? 0) >= T.isCommand;
  const isCorrection = Boolean(lastAction) && correction >= T.correction && finishedPhrase && isCmdEarly;

  // 0. Confirm / cancel handling for a pending destructive action.
  if (pending) {
    if (intentName === "confirm" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `confirm (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action confirmed");
      return { decision: "act", action: { ...pending, confirmed: true }, reasons, summary: `confirmed: ${describe(pending)}` };
    }
    if (intentName === "cancel" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `cancel (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action cancelled");
      return { decision: "cancel", reasons, summary: "cancelled pending action" };
    }
  }

  // 1. Correction of the previous action ("no, not that one", "wrong link, undo"). A bare "no"
  // is a reaction to the browser, not a fresh imperative, so this runs before the is_command gate.
  // When the user rejects what just happened and names no new target, reverse it; when they do
  // name a new target ("no, the other one") fall through and exclude the previous target below.
  if (isCorrection) {
    check(reasons, "is_correction", correction, T.correction, true, `rejects previous action: ${describe(lastAction)}`);
    const confidentIntent = intentName !== "none" && (intent?.confidence ?? 0) >= T.intentConfidence;
    // "the other one" names a new element; "not that one" alone does not (target comes back `none`
    // or the element just acted on) — the latter is a plain reversal.
    const namesNewTarget =
      TARGET_INTENTS.has(intentName) && topChoices(answers.target, 2).some((c) => c.id !== lastAction.targetId && c.p >= T.targetTopProb);
    // A confident closed-set command ("go back", "scroll down", "open youtube") said after a scroll
    // or click is what it says, not a request to reverse the last action: fall through to normal
    // handling. Only an unconfident / target-less correction is treated as "undo that".
    const reverse = lastAction.type !== "go_back" && (!confidentIntent || (TARGET_INTENTS.has(intentName) && !namesNewTarget));
    if (reverse) {
      const reversal = reverseAction(lastAction);
      return { decision: "act", action: reversal, reasons, summary: `correction → ${describe(reversal)}` };
    }
  }

  // 1b. Is the user talking to the browser at all?
  const isCmd = answers.is_command?.noul ?? 0;
  if (!check(reasons, "is_command", isCmd, T.isCommand, isCmd >= T.isCommand, "user is addressing the browser")) {
    return { decision: "ignore", reasons, summary: "not a browser command" };
  }

  // 2. Is there a confident intent?
  const conf = intent?.confidence ?? 0;
  const intentOk = intentName !== "none" && conf >= T.intentConfidence;
  check(reasons, "intent", `${intentName} (${r2(conf)})`, T.intentConfidence, intentOk, "confident, non-none intent");
  if (!intentOk) return { decision: "wait", reasons, summary: intentName === "none" ? "no recognizable command yet" : "intent not confident yet" };

  // 3. Has the user finished the command? (silence or a final result also counts)
  const complete = answers.complete?.noul ?? 0;
  const silent = silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const completeOk = complete >= T.complete || silent;
  check(
    reasons,
    "complete",
    complete,
    T.complete,
    completeOk,
    silent ? (isFinal ? "recognizer marked utterance final" : `silent for ${silentMs}ms`) : "command has verb + object",
  );
  if (!completeOk) return { decision: "wait", reasons, summary: "waiting for the rest of the command" };

  // 3b. Free-text payloads must be finished before they are copied verbatim.
  if (PAYLOAD_INTENTS.has(intentName)) {
    const payloadOk = isFinal || silentMs >= PAYLOAD_SILENCE_MS;
    check(
      reasons,
      "payload_final",
      isFinal ? "final" : `${silentMs}ms silence`,
      `final or ${PAYLOAD_SILENCE_MS}ms`,
      payloadOk,
      "free text (query / typed text) must be finished before it is copied",
    );
    if (!payloadOk) {
      return { decision: "wait", reasons, summary: "waiting for the end of the phrase (free text)", retryInMs: Math.max(50, PAYLOAD_SILENCE_MS - silentMs) };
    }
  }

  // 4. Build the concrete action (code owns URLs, templates and text; Jev only picked options).
  // On a correction that names a new target, the previous target is not an option ("the other one").
  const excludeTargetId = isCorrection && TARGET_INTENTS.has(intentName) ? lastAction.targetId ?? null : null;
  const built = buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId });
  if (built.decision !== "act") return { ...built, reasons };
  const action = built.action;

  // 5. Destructive? Only side-effecting element actions can be.
  const destructive = answers.destructive?.noul ?? 0;
  const canBeDestructive = ["click_element", "press_enter", "select_option"].includes(action.type);
  if (canBeDestructive) {
    const safe = destructive < T.destructive;
    check(reasons, "destructive", destructive, T.destructive, safe, safe ? "reversible action" : "needs spoken confirmation");
    if (!safe) {
      return { decision: "confirm", action, reasons, summary: `say "confirm" to ${describe(action)}` };
    }
    // The rule fast path (src/rules.js) answers "click ..." without asking the model whether
    // the action is destructive, so `destructive` is a hardcoded 0.1 there and always reads
    // "safe". Voice clicks therefore bypassed the confirmation entirely while pinch clicks,
    // which go through browser.clickElement(), were still guarded. Check the target element's
    // own text as well, so "click place order" asks for a spoken "confirm" on both paths.
    if (action.type === "click_element" && !action.confirmed) {
      const targetEl = (snapshot?.elements ?? []).find((e) => e.id === action.targetId);
      if (isDestructiveElement(targetEl)) {
        check(reasons, "destructive_text", action.label || action.targetId, "-", false, "risky button text needs confirmation");
        return { decision: "confirm", action, reasons, summary: `say "confirm" to ${describe(action)}` };
      }
    }
  }

  return { decision: "act", action, reasons, summary: describe(action) };
}

/** The action that undoes `action` as far as a browser can: navigations/clicks → back; typing → clear; tabs → close/switch. */
export function reverseAction(action) {
  switch (action?.type) {
    case "type_into_field":
      return { type: "type_into_field", targetId: action.targetId, text: "", submit: false, label: `clear ${action.label || action.targetId}` };
    case "open_new_tab":
      return { type: "close_tab", label: "close the new tab" };
    case "close_tab":
      return { type: "go_back", label: "back (tab already closed)" };
    case "switch_tab":
      return { type: "switch_tab", direction: action.direction === "previous" ? "next" : "previous", label: "switch back" };
    case "scroll_down":
      return { type: "scroll_up", amount: action.amount || "page", label: "scroll back up" };
    case "scroll_up":
      return { type: "scroll_down", amount: action.amount || "page", label: "scroll back down" };
    default:
      return { type: "go_back", label: `undo ${describe(action)}` };
  }
}

function buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId = null }) {
  const site = answers.site?.choice ?? "none";
  const elements = snapshot?.elements ?? [];

  switch (intentName) {
    case "navigate_url": {
      const urlPick = pickSpan(answers.url_span, T.spanConfidence, candidates.url?.[0]);
      if (urlPick) {
        check(reasons, "url_span", urlPick, T.spanConfidence, true, "domain spoken verbatim");
        return { decision: "act", action: { type: "navigate_url", url: toHttpUrl(urlPick), label: urlPick } };
      }
      // A named page inside a known site: "open shorts" -> youtube.com/shorts/. Checked BEFORE the
      // site homepage, otherwise "open shorts" would just reload the YouTube home page.
      const pathPick = pickSitePath(site, candidates.path);
      if (pathPick) {
        check(reasons, "site_path", pathPick.label, "-", true, "known page on this site");
        return { decision: "act", action: { type: "navigate_url", url: pathPick.url, label: pathPick.label } };
      }
      if (SITE_HOME[site]) {
        check(reasons, "site", `${site} (${r2(answers.site.confidence)})`, "-", true, "known site");
        return { decision: "act", action: { type: "navigate_url", url: SITE_HOME[site], label: site } };
      }
      check(reasons, "site", site, "known site or spoken domain", false, "no destination yet");
      return { decision: "wait", summary: "where to? (no site or domain recognised)" };
    }

    case "search_web": {
      const query = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (!query) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no query text yet");
        return { decision: "wait", summary: "search for what?" };
      }
      check(reasons, "text_span", query, T.spanConfidence, true, "query copied verbatim");
      if (SITE_SEARCH[site]) {
        return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[site], query), label: `search ${site}: ${query}`, query } };
      }
      if (snapshot?.searchBoxId && snapshot.site !== "blank") {
        return { decision: "act", action: { type: "type_into_field", targetId: snapshot.searchBoxId, text: query, submit: true, label: `search this site: ${query}` } };
      }
      return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[DEFAULT_SEARCH_ENGINE], query), label: `search: ${query}`, query } };
    }

    case "show_numbers":
      // Deliberately does not touch the elements list here: the controller numbers whatever the
      // snapshot holds, so the overlay and the spoken number always agree on the same ordering.
      return { decision: "act", action: { type: "show_numbers", label: "numbered the page" } };

    case "hide_numbers":
      return { decision: "act", action: { type: "hide_numbers", label: "hid the numbers" } };

    case "stop_listening":
      return { decision: "act", action: { type: "set_mic", on: false, label: "stopped listening" } };

    case "start_listening":
      return { decision: "act", action: { type: "set_mic", on: true, label: "listening again" } };

    case "press_key": {
      // The key itself comes from the rule table, never from the model.
      const key = answers.press_key?.key;
      if (!key) return { decision: "wait", reasons, summary: "which key?" };
      return { decision: "act", action: { type: "press_key", key, label: `press ${key}` } };
    }

    case "clear_field": {
      const focused = snapshot?.focusedFieldId;
      const id = focused || snapshot?.searchBoxId;
      if (!id) return { decision: "wait", reasons, summary: "nothing to clear — click a box first" };
      return { decision: "act", action: { type: "type_into_field", targetId: id, text: "", submit: false, label: elementLabel(snapshot?.elements ?? [], id) } };
    }

    case "click_element":
    case "select_option":
    case "type_into_field": {
      const target = answers.target;
      let top = topChoices(target, T.candidateCount + 1);
      let chosen = target?.choice;
      let chosenP = target?.probabilities?.[chosen] ?? 0;
      if (excludeTargetId && chosen === excludeTargetId) {
        // "no, the other one": the element just acted on is ruled out; take the runner-up.
        top = top.filter((c) => c.id !== excludeTargetId);
        chosen = top[0]?.id ?? "none";
        chosenP = top[0]?.p ?? 0;
        check(reasons, "exclude_target", excludeTargetId, "-", true, `previous target excluded → ${chosen}`);
      }
      top = top.slice(0, T.candidateCount);
      const targetOk =
        chosen && chosen !== "none" && target.confidence >= T.targetConfidence && chosenP >= T.targetTopProb;
      const text = intentName === "click_element" ? null : pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);

      if (intentName !== "click_element" && !text) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no text to type yet");
        return { decision: "wait", summary: "type what?" };
      }

      if (targetOk) {
        const label = elementLabel(elements, chosen);
        check(reasons, "target", `${chosen} (${r2(target.confidence)})`, T.targetConfidence, true, label);
        return { decision: "act", action: { type: intentName, targetId: chosen, text, label } };
      }

      // Typing with no confident target: fall back to the page's search box.
      if (intentName === "type_into_field" && snapshot?.searchBoxId) {
        check(reasons, "target", `${chosen} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "falling back to search box");
        return { decision: "act", action: { type: intentName, targetId: snapshot.searchBoxId, text, label: "search box" } };
      }

      check(reasons, "target", `${chosen ?? "none"} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "ambiguous target");
      // Show the plausible candidates (at least two when anything is plausible at all).
      let viable = top.filter((c) => c.p >= 0.08);
      if (viable.length === 1) viable = top.filter((c) => c.p >= 0.02).slice(0, 2);
      if (viable.length === 0) return { decision: "wait", summary: "no matching element on this page" };
      return {
        decision: "disambiguate",
        candidates: viable.map((c) => ({ ...c, label: elementLabel(elements, c.id) })),
        pendingIntent: { type: intentName, text },
        summary: `which one? ${viable.map((c, i) => `${i + 1}: ${elementLabel(elements, c.id)}`).join(" | ")}`,
      };
    }

    case "scroll_down":
    case "scroll_up": {
      const lvl = Math.round(answers.scroll_amount?.score ?? 1);
      const amount = ["little", "page", "end"][Math.min(2, Math.max(0, lvl))];
      check(reasons, "scroll_amount", answers.scroll_amount?.score ?? 1, "round", true, amount);
      return { decision: "act", action: { type: intentName, amount, label: `${intentName.replace("_", " ")} (${amount})` } };
    }

    case "switch_tab": {
      const dir = answers.tab_direction?.choice && answers.tab_direction.choice !== "none" ? answers.tab_direction.choice : "next";
      return { decision: "act", action: { type: "switch_tab", direction: dir, label: `switch tab (${dir})` } };
    }

    case "confirm":
    case "cancel":
      return { decision: "wait", summary: `nothing pending to ${intentName}` };

    default:
      return { decision: "act", action: { type: intentName, label: intentName.replace(/_/g, " ") } };
  }
}

export function elementLabel(elements, id) {
  const el = elements.find((e) => e.id === id);
  return el ? `${el.role} "${el.text || el.placeholder || ""}"` : id;
}

export function describe(action) {
  if (!action) return "";
  switch (action.type) {
    case "navigate_url":
      return `open ${action.label || action.url}`;
    case "type_into_field":
      return `type "${action.text}" into ${action.label || action.targetId}${action.submit ? " + enter" : ""}`;
    case "click_element":
      return `click ${action.label || action.targetId}`;
    case "select_option":
      return `select "${action.text}" in ${action.label || action.targetId}`;
    default:
      return action.label || action.type.replace(/_/g, " ");
  }
}

export { TARGET_INTENTS };
