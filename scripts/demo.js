#!/usr/bin/env node
/**
 * Demo / end-to-end test without a microphone.
 *
 * Replays scripted commands word by word (simulating partial speech transcripts) through the
 * SAME controller the live server uses, against real websites, and asserts the resulting URLs /
 * page state. Prints per-step Jev latency and how early (at which word) the browser acted.
 *
 *   npm run demo            # headed (watch it happen)
 *   npm run demo:ci         # headless, exits non-zero on failure
 *   node scripts/demo.js --headless --word-ms 250 --only 1,2,3
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "../src/browser.js";
import { Controller } from "../src/controller.js";
import { hasApiKey } from "../src/jev.js";
import { MODEL } from "../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const HEADLESS = args.includes("--headless") || process.env.CI === "1" || process.env.CI === "true";
const WORD_MS = Number(flag("--word-ms", HEADLESS ? 280 : 380));
const ONLY = flag("--only", null) ? String(flag("--only")).split(",").map(Number) : null;

if (!hasApiKey()) {
  console.error("Missing TYPESAFE_API_KEY (or JEV_API_KEY). Run via ./run.sh or export it.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, every = 150 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

const url = (b) => b.page?.url() || "";
const scrollY = (b) => b.page.evaluate(() => Math.round(window.scrollY)).catch(() => 0);

/** The scripted demo. `expect` returns truthy when the step succeeded. */
const STEPS = [
  { say: "go to wikipedia", expect: (b) => url(b).includes("wikipedia.org") },
  { say: "search for alan turing", expect: (b) => /Alan_Turing|search=alan/i.test(url(b)) },
  { say: "scroll down a bit", expect: async (b) => (await scrollY(b)) > 50 },
  { say: "scroll to the bottom", expect: async (b) => (await scrollY(b)) > 2000 },
  { say: "scroll up a page", expect: async (b) => (await scrollY(b)) < 900_000 }, // just must execute
  { say: "go back", expect: (b) => url(b).includes("wikipedia.org") && !/Alan_Turing/.test(url(b)) },
  { say: "open example dot com", expect: (b) => url(b).includes("example.com") },
  { say: "click the more information link", expect: (b) => url(b).includes("iana.org") },
  { say: "go to hacker news", expect: (b) => url(b).includes("news.ycombinator.com") },
  { say: "click the new link", expect: (b) => url(b).includes("news.ycombinator.com/newest") },
  {
    say: "click on a link please",
    // Ambiguous on purpose: either Jev is confident and clicks something, or it shows numbered
    // candidates and we answer with a number.
    followUpOnCandidates: "the first one",
    expect: (b) => !/news\.ycombinator\.com\/newest$/.test(url(b)),
  },
  { say: "search duckduckgo for typesafe jev", expect: (b) => /duckduckgo\.com\/\?q=typesafe(%20|\+)jev/.test(url(b)) },
  { say: "open a new tab", expect: (b) => b.pages.length === 2 },
  { say: "close this tab", expect: (b) => b.pages.length === 1 },
  // Two commands in one breath: the first executes as soon as it is complete, the remaining
  // words become a new command.
  { say: "go to example dot com and click the more information link", expect: (b) => url(b).includes("iana.org"), multi: true },
  { say: "so anyway I think we should get lunch", expectNoAction: true, expect: () => true },
];

async function main() {
  const profileDir = HEADLESS ? fs.mkdtempSync(path.join(os.tmpdir(), "vb-demo-")) : path.join(__dirname, "..", ".browser-profile-demo");
  const browser = new BrowserManager();
  await browser.launch({ headless: HEADLESS, profileDir, startUrl: "about:blank" });
  const controller = new Controller({ browser });
  if (process.env.VB_DEBUG) controller.on("log", (e) => console.error(`    [${e.level}] ${e.msg}`));
  await controller.start();

  console.log(`\nvoice-browser demo · model ${MODEL} · ${HEADLESS ? "headless" : "headed"} · ${WORD_MS}ms per spoken word\n`);

  const results = [];
  let stepNo = 0;
  for (const step of STEPS) {
    stepNo += 1;
    if (ONLY && !ONLY.includes(stepNo)) continue;
    const res = await runStep(step, stepNo, controller, browser);
    results.push(res);
    await sleep(500);
  }

  // ---- summary
  console.log("\n" + "─".repeat(100));
  console.log("step  result  acted@word  jev(ms)  word→decision(ms)  word→done(ms)  phrase");
  for (const r of results) {
    console.log(
      `${String(r.no).padStart(3)}   ${r.ok ? " PASS " : " FAIL "}  ${String(r.actedAt ?? "-").padStart(9)}  ${String(r.latency ?? "-").padStart(7)}  ${String(r.cmdToDecide ?? "-").padStart(17)}  ${String(r.cmdToAct ?? "-").padStart(13)}  "${r.say}"${r.note ? `  (${r.note})` : ""}`,
    );
  }
  const s = controller.uiState().stats;
  const passed = results.filter((r) => r.ok).length;
  const decided = results.map((r) => r.cmdToDecide).filter((x) => x != null);
  const avgDecide = decided.length ? Math.round(decided.reduce((a, b) => a + b, 0) / decided.length) : "-";
  console.log("─".repeat(100));
  console.log(
    `${passed}/${results.length} steps passed · ${s.calls} Jev calls · Jev latency avg ${s.avgLatencyMs} ms, p50 ${s.p50LatencyMs} ms · last word→decision avg ${avgDecide} ms · last word→action done avg ${s.avgCommandToActionMs} ms (includes page loads) · ${s.inputTokens} input tokens · $${s.costUsd.toFixed(5)} total`,
  );
  console.log("(word→decision includes the 200 ms debounce; acted@word < total means the browser acted before the sentence ended)");

  if (!HEADLESS) {
    console.log("\nLeaving the window open for 8 s…");
    await sleep(8000);
  }
  await controller.close();
  await browser.close();
  if (HEADLESS) fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
}

/**
 * Feed a phrase word by word as partial transcripts; resolve when the controller acts
 * (or shows candidates / asks for confirmation), then check the expectation.
 */
async function runStep(step, no, controller, browser) {
  const words = step.say.split(" ");
  const utteranceId = `demo-${no}`;
  let actedAt = null;
  let latency = null;
  let cmdToAct = null;
  let cmdToDecide = null;
  let candidates = null;
  let pending = null;
  let done = false;

  const onAction = (a) => {
    if (done) return;
    done = true;
    cmdToAct = a.sinceLastWordMs;
    cmdToDecide = a.decisionMs;
  };
  const onDecision = (d) => {
    if (d.policy.decision === "act") latency = d.latencyMs;
  };
  const onCandidates = (c) => (candidates = c);
  const onPending = (p) => (pending = p);
  controller.on("action", onAction);
  controller.on("decision", onDecision);
  controller.on("candidates", onCandidates);
  controller.on("pending", onPending);

  process.stdout.write(`${no}. "${step.say}" `);
  for (let i = 0; i < words.length; i++) {
    const partial = words.slice(0, i + 1).join(" ");
    if (done && !step.multi) break;
    controller.handleTranscript({ text: partial, final: false, utteranceId });
    process.stdout.write(".");
    await sleep(WORD_MS);
    if (done && actedAt == null) actedAt = `${i + 1}/${words.length}`;
  }
  if (!done || step.multi) {
    await sleep(300);
    controller.handleTranscript({ text: step.say, final: true, utteranceId });
  }

  const outcome = await waitFor(() => done || candidates || pending, { timeout: 12000 });
  if (done && actedAt == null) actedAt = `${words.length}/${words.length}`;

  if (!done && candidates && step.followUpOnCandidates) {
    process.stdout.write(` [${candidates.length} candidates → say "${step.followUpOnCandidates}"]`);
    await sleep(600);
    controller.handleTranscript({ text: step.followUpOnCandidates, final: true, utteranceId: `${utteranceId}-pick` });
    await waitFor(() => done, { timeout: 8000 });
  }

  let ok;
  let note = "";
  if (step.expectNoAction) {
    await sleep(1500);
    ok = !done && !candidates && !pending;
    note = ok ? "correctly ignored" : "should not have acted";
  } else {
    ok = Boolean(await waitFor(() => step.expect(browser), { timeout: 8000 }));
    if (!outcome) note = "no action within timeout";
  }
  console.log(` ${ok ? "✓" : "✗"} ${url(browser)}${note ? ` (${note})` : ""}`);

  controller.off("action", onAction);
  controller.off("decision", onDecision);
  controller.off("candidates", onCandidates);
  controller.off("pending", onPending);
  return { no, say: step.say, ok, actedAt, latency, cmdToAct, cmdToDecide, note };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
