import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EVAL_TASKS = [
  { id: "nav-search-click", title: "Navigate, search, open a result" },
  { id: "form-dictation", title: "Fill a short form" },
  { id: "scroll-select", title: "Scroll and select a target" },
  { id: "custom", title: "Custom task" },
];

const DEFAULT_PATH = path.resolve(process.cwd(), ".handsfree-evaluation.json");

const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

export function dictationAccuracy(expected, actual) {
  expected = String(expected || "").trim();
  actual = String(actual || "").trim();
  if (!expected && !actual) return null;
  if (!expected) return null;
  const distance = levenshtein(expected.toLowerCase(), actual.toLowerCase());
  return round(Math.max(0, 1 - distance / expected.length) * 100);
}

function newRun({ taskId = "custom", title = "", inputMethod = "handsfree", expectedText = "" } = {}, now = Date.now()) {
  const task = DEFAULT_EVAL_TASKS.find((t) => t.id === taskId);
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    title: title || task?.title || "Custom task",
    inputMethod,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    success: null,
    commands: [],
    actions: [],
    activations: [],
    manual: {
      commandCorrect: 0,
      commandIncorrect: 0,
      selectionErrors: 0,
      accidentalActivations: 0,
      dictationExpected: expectedText,
      dictationActual: "",
      notes: "",
    },
  };
}

function runStats(run) {
  const actionCount = run.actions.length;
  const okActions = run.actions.filter((a) => a.ok).length;
  const commandManualTotal = run.manual.commandCorrect + run.manual.commandIncorrect;
  const dictation = dictationAccuracy(run.manual.dictationExpected, run.manual.dictationActual);
  return {
    durationMs: run.durationMs ?? (run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null),
    commandCount: run.commands.length,
    actionCount,
    okActions,
    executionSuccessRate: actionCount ? round((okActions / actionCount) * 100) : null,
    commandAccuracy: commandManualTotal ? round((run.manual.commandCorrect / commandManualTotal) * 100) : null,
    selectionErrors: run.manual.selectionErrors,
    accidentalActivations: run.manual.accidentalActivations,
    dictationAccuracy: dictation,
  };
}

function summarizeRuns(runs) {
  const finished = runs.filter((r) => r.endedAt);
  const byMethod = {};
  for (const run of finished) {
    const s = runStats(run);
    const key = run.inputMethod || "unknown";
    byMethod[key] ||= {
      inputMethod: key,
      runs: 0,
      success: 0,
      avgTaskCompletionMs: null,
      avgCommandAccuracy: null,
      avgExecutionSuccessRate: null,
      totalSelectionErrors: 0,
      totalAccidentalActivations: 0,
      avgDictationAccuracy: null,
    };
    const bucket = byMethod[key];
    bucket.runs += 1;
    if (run.success === true) bucket.success += 1;
    bucket._durations ||= [];
    bucket._commandAccuracy ||= [];
    bucket._execution ||= [];
    bucket._dictation ||= [];
    if (s.durationMs != null) bucket._durations.push(s.durationMs);
    if (s.commandAccuracy != null) bucket._commandAccuracy.push(s.commandAccuracy);
    if (s.executionSuccessRate != null) bucket._execution.push(s.executionSuccessRate);
    if (s.dictationAccuracy != null) bucket._dictation.push(s.dictationAccuracy);
    bucket.totalSelectionErrors += s.selectionErrors;
    bucket.totalAccidentalActivations += s.accidentalActivations;
  }

  for (const bucket of Object.values(byMethod)) {
    bucket.avgTaskCompletionMs = avg(bucket._durations);
    bucket.avgCommandAccuracy = avg(bucket._commandAccuracy);
    bucket.avgExecutionSuccessRate = avg(bucket._execution);
    bucket.avgDictationAccuracy = avg(bucket._dictation);
    delete bucket._durations;
    delete bucket._commandAccuracy;
    delete bucket._execution;
    delete bucket._dictation;
  }

  return {
    runCount: runs.length,
    finishedCount: finished.length,
    byMethod: Object.values(byMethod).sort((a, b) => a.inputMethod.localeCompare(b.inputMethod)),
  };
}

function avg(xs) {
  return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

export class EvaluationStore {
  constructor({ filePath = DEFAULT_PATH, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.runs = [];
    this.active = null;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.runs = Array.isArray(data.runs) ? data.runs : [];
      this.active = data.active || null;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this.snapshot();
  }

  async save() {
    await fs.writeFile(this.filePath, `${JSON.stringify({ active: this.active, runs: this.runs }, null, 2)}\n`);
  }

  snapshot() {
    const runs = [...this.runs, ...(this.active ? [this.active] : [])];
    return {
      tasks: DEFAULT_EVAL_TASKS,
      active: this.active,
      runs: this.runs.slice(-50).map((r) => ({ ...r, stats: runStats(r) })),
      summary: summarizeRuns(runs),
      measured: {
        taskCompletionTime: "automatic when a run is started and finished",
        executionSuccessRate: "automatic from executed actions",
        commandAttempts: "automatic from decision/action events",
      },
      manual: {
        commandAccuracy: "mark correct/incorrect during or after a run",
        selectionErrors: "increment when the wrong element was selected",
        accidentalActivations: "increment when a click/action was unintended",
        dictationAccuracy: "enter expected and actual dictated text",
      },
    };
  }

  async start(opts = {}) {
    if (this.active) await this.finish({ success: false, notes: "Interrupted by a new run" });
    this.active = newRun(opts, this.now());
    await this.save();
    return this.snapshot();
  }

  async finish({ success = null, notes = "" } = {}) {
    if (!this.active) return this.snapshot();
    this.active.endedAt = this.now();
    this.active.durationMs = this.active.endedAt - this.active.startedAt;
    this.active.success = success == null ? null : Boolean(success);
    if (notes) this.active.manual.notes = notes;
    this.runs.push(this.active);
    this.active = null;
    await this.save();
    return this.snapshot();
  }

  async clear() {
    this.active = null;
    this.runs = [];
    await this.save();
    return this.snapshot();
  }

  async mark(patch = {}) {
    if (!this.active) return this.snapshot();
    const m = this.active.manual;
    if (patch.command === "correct") m.commandCorrect += 1;
    if (patch.command === "incorrect") m.commandIncorrect += 1;
    if (patch.selectionError) m.selectionErrors += 1;
    if (patch.accidentalActivation) m.accidentalActivations += 1;
    if (patch.dictationExpected != null) m.dictationExpected = String(patch.dictationExpected);
    if (patch.dictationActual != null) m.dictationActual = String(patch.dictationActual);
    if (patch.notes != null) m.notes = String(patch.notes);
    await this.save();
    return this.snapshot();
  }

  async recordDecision(decision) {
    if (!this.active || !decision?.transcript) return this.snapshot();
    this.active.commands.push({
      at: this.now(),
      transcript: decision.transcript,
      decision: decision.policy?.decision || null,
      actionType: decision.policy?.action?.type || null,
      targetId: decision.policy?.action?.targetId || null,
    });
    await this.save();
    return this.snapshot();
  }

  async recordAction(entry) {
    if (!this.active || !entry?.action) return this.snapshot();
    this.active.actions.push({
      at: this.now(),
      type: entry.action.type,
      targetId: entry.action.targetId ?? null,
      ok: Boolean(entry.ok),
      via: entry.via || "unknown",
      detail: String(entry.detail || "").slice(0, 160),
    });
    await this.save();
    return this.snapshot();
  }

  async recordActivation(info = {}) {
    if (!this.active) return this.snapshot();
    this.active.activations.push({
      at: this.now(),
      source: info.source || "unknown",
      x: typeof info.x === "number" ? round(info.x, 4) : null,
      y: typeof info.y === "number" ? round(info.y, 4) : null,
    });
    await this.save();
    return this.snapshot();
  }
}
