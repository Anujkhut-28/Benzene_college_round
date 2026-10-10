/**
 * Orchestrator: transcript updates -> (debounce, cancel stale) -> one Jev request ->
 * policy -> Playwright action -> fresh snapshot. Emits events for the UI / demo / tests.
 */
import { EventEmitter } from "node:events";
import { DEBOUNCE_MS, SILENCE_COMPLETE_MS, CANDIDATE_TTL_MS, MAX_INFLIGHT, MAX_CONTEXT_ACTIONS, MODEL, T, isDestructiveElement } from "./constants.js";

/**
 * How long an in-flight decision may run before we stop cancelling it in favour of a newer
 * transcript. The cloud API answers in ~300 ms, so cancelling stale work is always right there.
 * A local model on CPU can take seconds, and at that point every new partial transcript would
 * cancel the last — the decision would never land at all. Past this age the request is allowed
 * to finish and its answer is used if it is still the current utterance.
 */
const STALE_AFTER_MS = Number(process.env.JEV_STALE_AFTER_MS) || 4000;

const MAX_SILENCE_RETRIES = Number(process.env.JEV_MAX_RETRIES) || 6;
import { decide, isAbortError, BACKEND } from "./jev.js";
import { MODEL_LABEL } from "./local-jev.js";
import { evaluatePolicy, describe } from "./policy.js";
import { execute } from "./executor.js";
import { parseCandidatePick, cleanTranscript } from "./spans.js";
import { recognize } from "./rules.js";
import { matchMacro, loadMacros } from "./macros.js";

// Actions that make no sense to replay on "again".
const SKIP_REPEAT = new Set(["repeat_last", "stop_scrolling", "start_scrolling", "set_mic", "read_page", "show_numbers", "hide_numbers"]);
import { approxTokens } from "./snapshot.js";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export class Controller extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').BrowserManager, decideFn?: Function, executeFn?: Function}} opts
   *   decideFn / executeFn are injectable for tests (default: real Jev + Playwright).
   */
  constructor({ browser, decideFn = decide, executeFn = execute }) {
    super();
    this.browser = browser;
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm"
    // Dictation: once the user is in a field, unrecognised words are typed rather than ignored.
    this.dictation = false;
    // The single previous action, for "again". Never a queue.
    this.lastAction = null;
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Jev
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: BACKEND === "local" ? MODEL_LABEL : MODEL, commandToActionMs: [], decisionMs: [] };
    this.history = [];
    // Conversation context sent to Jev with every request (see jev.encodeContext):
    // the page before the last navigation and the last few executed actions.
    this.context = { previousPage: null, recentActions: [] };
    browser.onChange(() => this.emit("tabs", browser.tabInfo()));
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `ready — model ${this.stats.model}, ${this.snapshot.elements.length} elements on ${this.snapshot.url}`);
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /** Typed command fallback: behaves like a final utterance. */
  handleCommand(text) {
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  /**
   * Called on every partial transcript from the mic (or the demo replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    let clean = cleanTranscript(text);
    const now = Date.now();

    // One action per utterance — but if the user keeps talking in the same breath
    // ("go to wikipedia ... search for alan turing"), the words after the already-executed
    // command become a fresh virtual utterance (id "<physical>+<n>"). Fewer than two new words
    // ("please") are ignored.
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // recognizer revised the executed words; ignore
      clean = clean.slice(consumed.prefix.length).trim();
      if (clean.split(/\s+/).filter(Boolean).length < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    if (!this.utterance || this.utterance.id !== virtualId) {
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
      };
      if (virtualId !== utteranceId) this._log("debug", `continuing utterance → new command "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    if (!clean || this.utterance.actedOn) return;

    // Deterministic shortcut: numbered candidate overlays + a spoken number => no Jev needed.
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        this._consume(this.utterance, clean);
        this._log("info", `picked candidate ${n} (${c.label}) by number — no model call`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        // Picking by number skips evaluatePolicy, so the destructive gate has to be applied
        // here too: "show numbers" then "click 3" must not be a way around saying "confirm".
        if (action.type === "click_element") {
          const el = (this.snapshot?.elements ?? []).find((e) => e.id === c.id);
          if (isDestructiveElement(el)) {
            this.pending = action;
            // handleTranscript is sync, so this is fire-and-forget like the _runAction below.
            this.browser.overlay("toast", `Say "confirm" to click ${c.label}`, 5000).catch(() => {});
            this.emit("pending", { action, summary: `confirm to click ${c.label}` });
            this.emit("say", { text: `That looks risky. Say confirm to click ${String(c.label).trim()}, or cancel.`, priority: "high" });
            this._scheduleSilenceRetry(this.utterance);
            return;
          }
        }
        this.candidates = null;
        this._runAction(action, { via: "candidate-pick" });
        return;
      }
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** Ask Jev about the current utterance. Cancels any in-flight request. */
  async decideNow(trigger = "manual") {
    const utt = this.utterance;
    if (!utt || !utt.text || utt.actedOn) return;
    if (this.busy) {
      // An action is executing; re-evaluate once it finishes.
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // A dialog is blocking the page. "yes"/"no"/"ok"/"cancel" answer it directly, but only while
    // one is actually open - these words already mean confirm and cancel everywhere else, so
    // they must not be hijacked globally.
    if (this.browser.pendingDialog) {
      const answer = /^(yes|ok|okay|accept|allow|confirm|do it|go ahead)\b/.test(utt.text.toLowerCase().trim());
      const refuse = /^(no|nope|deny|cancel|dismiss|don't|do not|stop)\b/.test(utt.text.toLowerCase().trim());
      if (answer || refuse) {
        this._consume(utt, utt.text);
        await this._runAction({ type: "answer_prompt", accept: answer, label: answer ? "accepted" : "dismissed" }, { via: "dialog" });
        return;
      }
    }

    // A user-defined macro, before anything else: "do my timesheet" is a sequence, not a command.
    const macro = matchMacro(utt.text);
    if (macro) {
      this._consume(utt, utt.text);
      this._log("info", `running macro "${macro.name}" (${macro.steps.length} steps)`);
      this.emit("say", { text: `Running ${macro.name}.` });
      await this._runMacro(macro);
      return;
    }

    // Dictation. With a field focused, words that are not a command are simply text to type.
    // Checked before the model so it costs nothing, and only for words the rule table does not
    // recognise — a real command always wins over being typed into a box.
    if (this.dictation && this.snapshot?.focusedFieldId) {
      const ruled = recognize(utt.text, { site: this.snapshot.site });
      const isCommand = ruled && ruled.intent?.choice && ruled.intent.choice !== "none";
      if (!isCommand) {
        const text = utt.text.trim();
        if (text) {
          this._consume(utt, text);
          this._log("act", `dictated "${text}" into the focused field`);
          await this._runAction({ type: "type_into_focus", text, label: `typed "${text}"` }, { via: "dictation" });
        }
        return;
      }
    }

    // Allow up to MAX_INFLIGHT overlapping requests (a request for the previous partial may
    // still be useful — if the words already commit to an action we act on it). Anything older
    // is stale and gets cancelled via AbortSignal.
    //
    // Only useful while a decision is fast. Every transcript update supersedes the last, so if a
    // request outlives the gap between partial transcripts there is *always* a newer one to
    // cancel it with and no decision ever lands ("cancelled stale request" forever). Past
    // STALE_AFTER_MS we let the request finish instead and drop its answer if it went stale —
    // a late answer for the words just spoken beats no answer at all.
    while (this.inflight.length >= MAX_INFLIGHT) {
      const oldest = this.inflight[0];
      if (Date.now() - oldest.at < STALE_AFTER_MS) {
        this.inflight.shift();
        oldest.ac.abort();
      } else {
        this.inflight.shift(); // stop tracking it; its result is ignored when it lands
      }
    }
    const ac = new AbortController();
    const req = { ac, text: utt.text, at: Date.now() };
    this.inflight.push(req);

    if (Date.now() - this.snapshotAt > 1500) await this.refreshSnapshot();

    const textAtRequest = utt.text;
    let result;
    try {
      result = await this._decide(
        {
          transcript: textAtRequest,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context: this.context,
        },
        { signal: ac.signal },
      );
    } catch (err) {
      this.inflight = this.inflight.filter((r) => r !== req);
      if (isAbortError(err) || ac.signal.aborted) {
        this._log("debug", `cancelled stale request for "${textAtRequest}"`);
        return;
      }
      this._log("error", `Jev error: ${err.message || err}`);
      this.emit("error", err);
      return;
    }
    this.inflight = this.inflight.filter((r) => r !== req);
    if (ac.signal.aborted || this.utterance !== utt || utt.actedOn) return;

    this.stats.calls += 1;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.costUsd += result.costUsd;
    this.stats.latencies.push(result.latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
    if (result.model && result.model !== this.stats.model) this.stats.model = result.model;

    // If more words arrived while this request was in flight, its transcript is a prefix of the
    // real one: it may still act on closed-set intents (the words already commit to "go back"),
    // but it must never be treated as final/silent — free-text payloads would be truncated.
    const stale = utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      silentMs,
      isFinal: utt.final && !stale,
      pending: this.pending,
      context: this.context,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      silentMs,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
    );

    let actionResult = null;
    switch (policy.decision) {
      case "act":
        this._consume(utt, textAtRequest);
        if (policy.action.confirmed) this.pending = null;
        this.candidates = null;
        // The mic lives in the control page, not the controlled one, so this cannot be a
        // Playwright action - it is a message back to the tab that owns the recognizer.
        if (policy.action.type === "set_mic") {
          this.emit("mic", { on: policy.action.on });
          this._log("info", policy.action.on ? "listening again" : "stopped listening");
          break;
        }
        // Continuous scrolling is a loop owned here, not a browser action: it repeats a plain
        // scroll until "stop scrolling" arrives or the page runs out of room.
        if (policy.action.type === "start_scrolling") {
          this._consume(utt, textAtRequest);
          this._startContinuousScroll(policy.action.direction || "down");
          break;
        }
        if (policy.action.type === "stop_scrolling") {
          this._consume(utt, textAtRequest);
          const was = this._stopContinuousScroll();
          this._log("info", was ? "stopped scrolling" : "was not scrolling");
          this.emit("say", { text: was ? "Stopped scrolling." : "" });
          break;
        }
        // "again" re-runs whatever was last done. Kept out of the policy's reach on purpose:
        // repeating a navigation is harmless, repeating a click is not, so this only ever
        // replays the single previous action and never a queued list.
        if (policy.action.type === "repeat_last") {
          this._consume(utt, textAtRequest);
          const prev = this.lastAction;
          if (!prev) {
            this._log("info", "nothing to repeat");
            this.emit("say", { text: "There is nothing to repeat." });
            break;
          }
          this._log("info", `repeating: ${prev.type}`);
          await this._runAction(prev, { via: "repeat" });
          break;
        }
        actionResult = await this._runAction(policy.action, { decision, utterance: utt });
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this.pending = policy.action;
        await this.browser.overlay("toast", `Say "confirm" to ${describe(policy.action)}`, 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        // The toast is invisible to someone who cannot see the screen, which is much of the
        // audience this is for. Say it.
        this.emit("say", { text: `Say confirm to ${describe(policy.action)}`, priority: "high" });
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this.pending = null;
        await this.browser.overlay("toast", "cancelled");
        this.emit("pending", null);
        break;
      case "disambiguate": {
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now() };
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", "Which one? Say the number.", 3000);
        this.emit("candidates", list);
        this.emit("say", { text: `Which one? There are ${list.length}. Say the number.` });
        this._scheduleSilenceRetry(utt);
        break;
      }
      case "wait":
        this._scheduleSilenceRetry(utt, policy.retryInMs);
        break;
      default:
        break;
    }

    // "show numbers" is answered after the action runs, because the executor re-reads the live
    // DOM and reports what it actually badged. The overlay and the spoken number must agree, so
    // the list only becomes pickable once we know it.
    if (policy.action?.type === "show_numbers" && actionResult?.numbered?.length) {
      const list = actionResult.numbered;
      this.candidates = { list, intent: { type: "click_element" }, at: Date.now() };
      await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
      await this.browser.overlay("toast", `Numbered ${list.length}. Say "click" and a number.`, 4000);
      this.emit("candidates", list);
      this.emit("say", { text: `Numbered ${list.length}. Say click and a number.` });
      this._scheduleSilenceRetry(utt);
    }
  }

  /** If the user stops talking, re-evaluate with silentMs so `complete` is bypassed. */
  _scheduleSilenceRetry(utt, retryInMs = null) {
    clearTimeout(this.silenceTimer);
    utt.retries = (utt.retries || 0) + 1;
    if (utt.retries > MAX_SILENCE_RETRIES) return;
    const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) this.decideNow("silence");
    }, waitFor);
  }

  /**
   * Run a macro's steps in order, each through the same recognise -> policy -> execute path as
   * anything spoken by hand. Stops at the first step that does not act, so a macro never barrels
   * on past a confirmation prompt the user has not answered yet.
   */
  async _runMacro(macro) {
    for (let i = 0; i < macro.steps.length; i++) {
      const step = macro.steps[i];
      const answered = await this._runOneStep(step);
      if (answered === "stop") {
        this._log("info", `macro "${macro.name}" stopped at step ${i + 1}: "${step}"`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this._log("act", `macro "${macro.name}" finished`);
    this.emit("say", { text: `${macro.name} done.` });
  }

  /** One macro step. Returns "stop" when the step left something pending for the user. */
  async _runOneStep(text) {
    const utt = {
      id: `macro-${Date.now()}`,
      physicalId: "",
      prefix: "",
      gen: 0,
      text,
      final: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      actedOn: false,
      actedText: null,
    };
    const prevUtterance = this.utterance;
    this.utterance = utt;
    try {
      const result = await this._decide(
        {
          transcript: text,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context: this.context,
        },
        {},
      );
      const policy = evaluatePolicy({
        answers: result.answers,
        candidates: result.candidates,
        snapshot: this.snapshot,
        isFinal: true,
        silentMs: SILENCE_COMPLETE_MS,
        pending: this.pending,
        context: this.context,
      });
      // Anything that is not a clean "do it" stops the macro, so it never barrels past a
      // confirmation the user has not answered or a target it could not resolve.
      if (policy.decision !== "act") return "stop";
      utt.actedOn = true;
      if (policy.action.confirmed) this.pending = null;
      await this._runAction(policy.action, { via: "macro" });
      return "ok";
    } catch (err) {
      this._log("error", `macro step "${text}" failed: ${err?.message || err}`);
      return "stop";
    } finally {
      this.utterance = prevUtterance;
    }
  }

  /**
   * "Keep scrolling" repeats a plain scroll on a timer. It has to be stoppable by voice, so the
   * timer is tracked and cancelled by "stop scrolling" and by navigating away — leaving the page
   * moving on its own after the user has moved on is disorienting.
   */
  _startContinuousScroll(direction) {
    this._stopContinuousScroll();
    const type = { up: "scroll_up", left: "scroll_left", right: "scroll_right" }[direction] ?? "scroll_down";
    let still = 0;
    this._scrollTimer = setInterval(async () => {
      if (this.busy) return;
      try {
        const res = await this._execute({ type, amount: "page", label: `scroll ${direction}` }, this.browser);
        // Stop once the page stops moving: that is the bottom, or the right-hand edge.
        if (still++ > 40) this._stopContinuousScroll();
        this._recordContext({ action: { type }, ok: res.ok, detail: res.detail, said: "keep scrolling" });
      } catch {
        this._stopContinuousScroll();
      }
    }, 420);
    this._log("act", `scrolling ${direction} until you say stop`);
    this.emit("say", { text: `Scrolling ${direction}. Say stop to stop.` });
  }

  _stopContinuousScroll() {
    if (!this._scrollTimer) return false;
    clearInterval(this._scrollTimer);
    this._scrollTimer = null;
    return true;
  }

  /**
   * Dictation follows the caret. Clicking a text field or typing into one turns it on; Tab and
   * Escape leave it on, because filling in a form means dictating, tabbing, dictating again.
   * Anything that navigates away, or a microphone command, turns it off.
   */
  _updateDictation(action) {
    const type = action?.type;
    if (type === "navigate_url" || type === "go_back" || type === "set_mic" || type === "press_enter") {
      this.dictation = false;
      // Navigating away must not leave the page scrolling itself.
      this._stopContinuousScroll();
      return;
    }
    if (type === "press_key") {
      if (["Tab", "Escape"].includes(action.key)) return; // caret moves, mode stays
      this.dictation = false;
      return;
    }
    if (type === "click_element" || type === "type_into_field") {
      // Only fields turn dictation on; clicking a link should not.
      const el = (this.snapshot?.elements ?? []).find((e) => e.id === action.targetId);
      const role = el?.role || "";
      this.dictation = /textbox|searchbox|combobox|input|textarea/.test(role);
    }
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    try {
      const res = await this._execute(action, this.browser);
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      // Remembered for "again". Destructive and repeating actions are excluded: replaying
      // "place order" because the user said "again" is not what anyone wants.
      if (action?.type && !SKIP_REPEAT.has(action.type) && !(action.confirmed === false && isDestructiveElement((this.snapshot?.elements ?? []).find((e) => e.id === action.targetId)))) {
        this.lastAction = action;
      }
      if (res.speak) this.emit("say", { text: res.speak });
      this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "jev",
      };
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)} — decided ${decisionMs ?? "?"}ms after last word, executed in ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
      // Done here rather than at the call sites: actions reach this method from the policy
      // branch, from a candidate pick, and from undo, and each must update dictation.
      this._updateDictation(action);
      return res;
    } catch (err) {
      this._log("error", `action failed: ${describe(action)} — ${err.message || err}`);
      this.emit("action", { action, ok: false, detail: String(err.message || err) });
      this.emit("say", { text: `Sorry, that did not work. ${describe(action)} failed.`, priority: "high" });
      return null;
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * Remember what was just done so the next Jev request can resolve "back to the results",
   * "the other one", "not that one". Called after every executed action; the page snapshot is
   * refreshed by the caller right after, so `outcome` is derived from the post-action URL.
   */
  _recordContext({ action, ok, detail, said, pageBefore }) {
    const after = this.browser.currentUrl?.() ?? null;
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) this.context.previousPage = pageBefore;
    let outcome = ok ? "done" : "failed";
    if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    this.context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (this.context.recentActions.length > MAX_CONTEXT_ACTIONS) this.context.recentActions.shift();
  }

  /** "Undo" = go back in history. */
  async undo() {
    await this._runAction({ type: "go_back", label: "undo (back)" }, { via: "undo" });
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        focusedFieldId: this.snapshot.focusedFieldId ?? null,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
      },
      // Dictation is on when the caret sits in a field; surfaced so the control page can show it.
      dictation: this.dictation,
      lastDecision: this.lastDecision,
      context: this.context,
      pending: this.pending ? { summary: describe(this.pending) } : null,
      candidates: this.candidates?.list ?? null,
      log: this.log.slice(-60),
    };
  }

  async close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
