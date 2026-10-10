/**
 * Integration test against the REAL Jev API: given a page snapshot fixture and a transcript,
 * does the (Jev answers -> policy) pipeline produce the expected intent / target / decision?
 *
 * Prints a pass-rate report and per-call latency. Requires TYPESAFE_API_KEY (or JEV_API_KEY);
 * skips otherwise. Cost of a full run: well under one cent.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, hasApiKey } from "../../src/jev.js";
import { evaluatePolicy } from "../../src/policy.js";
import { MODEL } from "../../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));

// A realistic search-results page (DuckDuckGo chrome captured live; result links written by hand
// because results render client-side and don't appear in headless captures).
const SEARCH_RESULTS = {
  url: "https://duckduckgo.com/?q=jev+typesafe",
  title: "jev typesafe at DuckDuckGo",
  site: "duckduckgo",
  searchBoxId: "e02",
  elements: [
    { id: "e01", role: "link", text: "DuckDuckGo home", href: "duckduckgo.com" },
    { id: "e02", role: "combobox", text: "jev typesafe", placeholder: "Search privately" },
    { id: "e03", role: "button", text: "Search" },
    { id: "e05", role: "link", text: "All", href: "duckduckgo.com" },
    { id: "e06", role: "link", text: "Images", href: "duckduckgo.com" },
    { id: "e07", role: "link", text: "Videos", href: "duckduckgo.com" },
    { id: "e08", role: "link", text: "News", href: "duckduckgo.com" },
    { id: "e12", role: "button", text: "Search Settings" },
    { id: "e20", role: "link", text: "TypeSafe — Jev, the System One model", href: "typesafe.ai" },
    { id: "e21", role: "link", text: "typesafe.ai", href: "typesafe.ai" },
    { id: "e22", role: "link", text: "Jev 1.13 | TypeSafe Documentation", href: "docs.typesafe.ai/models/jev" },
    { id: "e23", role: "link", text: "docs.typesafe.ai", href: "docs.typesafe.ai" },
    { id: "e24", role: "link", text: "GitHub - typesafe-ai/typesafe-sdk-js: TypeScript SDK", href: "github.com/typesafe-ai/typesafe-sdk-js" },
    { id: "e25", role: "link", text: "github.com", href: "github.com" },
    { id: "e26", role: "link", text: "TypeSafe (@typesafe_ai) / X", href: "x.com/typesafe_ai" },
    { id: "e27", role: "button", text: "More results" },
    { id: "e28", role: "link", text: "Settings", href: "duckduckgo.com/settings", below_fold: true },
    { id: "e29", role: "link", text: "Privacy Policy", href: "duckduckgo.com/privacy", below_fold: true },
  ],
};

const FORM_PAGE = {
  url: "https://shop.example.com/checkout",
  title: "Checkout — Example Shop",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "Example Shop" },
    { id: "e02", role: "textbox", text: "", placeholder: "Email address" },
    { id: "e03", role: "textbox", text: "", placeholder: "Card number" },
    { id: "e04", role: "select", text: "Country" },
    { id: "e05", role: "button", text: "Place order" },
    { id: "e06", role: "link", text: "Back to cart" },
    { id: "e07", role: "button", text: "Delete account" },
  ],
};

/**
 * Each case: transcript + snapshot + expectations on Jev's raw answers and/or the policy result.
 *   intent:   expected `intent.choice`
 *   target:   expected `target.choice` (optional)
 *   decision: expected policy decision (optional)
 *   text:     expected verbatim text_span (optional)
 *   final:    treat as a final utterance (default true so `complete` doesn't gate)
 */
const CASES = [
  { name: "scroll a bit", transcript: "scroll down a bit", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "little" },
  { name: "scroll to bottom", transcript: "scroll all the way to the bottom", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "end" },
  { name: "scroll up", transcript: "scroll up", snapshot: "hn", intent: "scroll_up", decision: "act" },
  { name: "go to wikipedia", transcript: "go to wikipedia", snapshot: "example", intent: "navigate_url", decision: "act", url: "wikipedia.org" },
  { name: "open youtube", transcript: "open youtube", snapshot: "hn", intent: "navigate_url", decision: "act", url: "youtube.com" },
  { name: "spoken domain", transcript: "go to example dot com", snapshot: "hn", intent: "navigate_url", decision: "act", url: "example.com" },
  { name: "search web", transcript: "search for jev typesafe", snapshot: "example", intent: "search_web", decision: "act", text: "jev typesafe", url: "duckduckgo.com" },
  { name: "search on site with box", transcript: "search for alan turing", snapshot: "wikipedia-main", intent: "search_web", decision: "act", text: "alan turing", target: "e02" },
  { name: "search named site", transcript: "search youtube for lofi beats", snapshot: "hn", intent: "search_web", decision: "act", text: "lofi beats", url: "youtube.com/results" },
  { name: "look up", transcript: "look up the weather in berlin", snapshot: "example", intent: "search_web", decision: "act", text: "the weather in berlin" },
  { name: "click first result", transcript: "click the first result", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e20", decision: "act" },
  { name: "click github result", transcript: "click the github link", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e24", decision: "act" },
  { name: "click by text", transcript: "click the more information link", snapshot: "example", intent: "click_element", target: "e01", decision: "act" },
  { name: "click hn new", transcript: "click new", snapshot: "hn", intent: "click_element", target: "e03", decision: "act" },
  { name: "click hn comments", transcript: "open the comments tab", snapshot: "hn", intent: "click_element", target: "e05", decision: "act" },
  { name: "go back", transcript: "go back", snapshot: "wikipedia-article", intent: "go_back", decision: "act" },
  { name: "type into box", transcript: "type hello world into the search box", snapshot: "wikipedia-main", intent: "type_into_field", target: "e02", text: "hello world", decision: "act" },
  { name: "reload", transcript: "refresh the page", snapshot: "hn", intent: "reload", decision: "act" },
  { name: "new tab", transcript: "open a new tab", snapshot: "hn", intent: "open_new_tab", decision: "act" },
  { name: "chit-chat ignored", transcript: "so anyway I think we should get lunch", snapshot: "hn", decision: "ignore" },
  { name: "filler ignored", transcript: "um okay so", snapshot: "hn", decisionIn: ["ignore", "wait"] },
  { name: "partial go to waits", transcript: "go to", snapshot: "hn", final: false, decision: "wait" },
  { name: "partial search waits", transcript: "search for", snapshot: "hn", final: false, decision: "wait" },
  { name: "destructive asks confirm", transcript: "click place order", snapshot: FORM_PAGE, intent: "click_element", target: "e05", decision: "confirm" },
  { name: "destructive delete", transcript: "press delete account", snapshot: FORM_PAGE, intent: "click_element", target: "e07", decision: "confirm" },
  { name: "type email", transcript: "type bob at example dot com in the email field", snapshot: FORM_PAGE, intent: "type_into_field", target: "e02", decision: "act" },
  { name: "missing element waits", transcript: "click sign in", snapshot: "example", intent: "click_element", decisionIn: ["wait", "disambiguate"] },
];

// --- Context-aware cases: the user just searched DuckDuckGo and clicked the first result. ---
const PRODUCT_PAGE = {
  url: "https://typesafe.ai/jev",
  title: "Jev — the System One model | TypeSafe",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "TypeSafe", href: "typesafe.ai" },
    { id: "e02", role: "link", text: "Product" },
    { id: "e03", role: "link", text: "Documentation", href: "docs.typesafe.ai" },
    { id: "e04", role: "link", text: "Pricing" },
    { id: "e05", role: "link", text: "Blog" },
    { id: "e06", role: "button", text: "Get an API key" },
    { id: "e07", role: "link", text: "Read the docs", href: "docs.typesafe.ai/introduction" },
    { id: "e08", role: "link", text: "Join Discord", href: "discord.com" },
  ],
};
const AFTER_CLICK_CONTEXT = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "navigate_url", url: "https://duckduckgo.com/?q=jev+typesafe", said: "search for jev typesafe", ok: true, outcome: "navigated to duckduckgo.com/?q=jev+typesafe", at: Date.now() - 25_000 },
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "click the first result", ok: true, outcome: "navigated to typesafe.ai/jev", at: Date.now() - 6_000 },
  ],
};
const ON_RESULTS_AFTER_CLICK = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "click the first result", ok: true, outcome: "navigated to typesafe.ai/jev", at: Date.now() - 8_000 },
    { type: "go_back", said: "go back", ok: true, outcome: "navigated to duckduckgo.com/?q=jev+typesafe", at: Date.now() - 3_000 },
  ],
};

CASES.push(
  { name: "ctx: open the documentation", transcript: "open the documentation", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "click_element", targetIn: ["e03", "e07"], decision: "act" },
  { name: "ctx: back to the results", transcript: "go back to the search results", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "go_back", decision: "act" },
  { name: "ctx: correction reverses", transcript: "no not that one", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "ctx: wrong link undo", transcript: "wrong link, undo that", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "ctx: the other one", transcript: "no, the other one", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, correction: true, intent: "click_element", targetNot: "e20", decisionIn: ["act", "disambiguate"] },
  { name: "ctx: follow-up not a correction", transcript: "scroll down a bit", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: false, intent: "scroll_down", decision: "act" },
  // The fixture lists each result's URL line as its own link right after the title (e20 title, e21 url,
  // e22 second title), so "second result" is genuinely ambiguous at the element level; both are accepted.
  { name: "ctx: second result after back", transcript: "click the second result", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, intent: "click_element", targetIn: ["e21", "e22"], decision: "act" },
);

const results = [];

before(() => {
  if (!hasApiKey()) console.log("SKIP: no TYPESAFE_API_KEY / JEV_API_KEY set");
});

for (const c of CASES) {
  test(`jev: ${c.name} — "${c.transcript}"`, { skip: !hasApiKey() }, async () => {
    const snapshot = typeof c.snapshot === "string" ? fixture(c.snapshot) : c.snapshot;
    const r = await decide({ transcript: c.transcript, snapshot, context: c.context ?? null });
    const policy = evaluatePolicy({ answers: r.answers, candidates: r.candidates, snapshot, isFinal: c.final !== false, context: c.context ?? null });
    const a = r.answers;
    const failures = [];
    if (c.intent && a.intent.choice !== c.intent) failures.push(`intent ${a.intent.choice} != ${c.intent} (conf ${a.intent.confidence.toFixed(2)})`);
    if (c.target && a.target.choice !== c.target) failures.push(`target ${a.target.choice} != ${c.target} (conf ${a.target.confidence.toFixed(2)})`);
    if (c.targetIn && !c.targetIn.includes(policy.action?.targetId ?? a.target.choice)) failures.push(`target ${policy.action?.targetId ?? a.target.choice} not in ${c.targetIn}`);
    if (c.targetNot && policy.action?.targetId === c.targetNot) failures.push(`target ${policy.action.targetId} should not be ${c.targetNot}`);
    if (c.correction === true && (a.is_correction?.noul ?? 0) < 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} < 0.6`);
    if (c.correction === false && (a.is_correction?.noul ?? 0) >= 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} >= 0.6`);
    if (c.actionType && policy.action?.type !== c.actionType) failures.push(`action ${policy.action?.type} != ${c.actionType}`);
    if (c.decision && policy.decision !== c.decision) failures.push(`decision ${policy.decision} != ${c.decision} (${policy.summary})`);
    if (c.decisionIn && !c.decisionIn.includes(policy.decision)) failures.push(`decision ${policy.decision} not in ${c.decisionIn} (${policy.summary})`);
    if (c.text && policy.action?.text !== c.text && policy.action?.query !== c.text) failures.push(`text ${JSON.stringify(policy.action?.text ?? policy.action?.query)} != ${JSON.stringify(c.text)}`);
    if (c.url && !(policy.action?.url || "").includes(c.url)) failures.push(`url ${policy.action?.url} !~ ${c.url}`);
    if (c.amount && policy.action?.amount !== c.amount) failures.push(`amount ${policy.action?.amount} != ${c.amount}`);

    results.push({ name: c.name, ok: failures.length === 0, latency: r.latencyMs, tokens: r.usage.input_tokens, failures });
    console.log(
      `  ${failures.length ? "✗" : "✓"} ${c.name.padEnd(26)} ${String(r.latencyMs).padStart(4)}ms ${String(r.usage.input_tokens).padStart(5)}tok  intent=${a.intent.choice}(${a.intent.confidence.toFixed(2)}) target=${a.target.choice}(${a.target.confidence.toFixed(2)}) complete=${a.complete.noul.toFixed(2)} cmd=${a.is_command.noul.toFixed(2)} destr=${a.destructive.noul.toFixed(2)} → ${policy.decision}${failures.length ? "\n      " + failures.join("; ") : ""}`,
    );
    assert.deepEqual(failures, [], failures.join("; "));
  });
}

test("integration pass-rate report", { skip: !hasApiKey() }, () => {
  const passed = results.filter((r) => r.ok).length;
  const lat = results.map((r) => r.latency).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  const tokens = results.reduce((a, r) => a + r.tokens, 0);
  const rate = passed / results.length;
  console.log(`\n  ${MODEL}: ${passed}/${results.length} cases passed (${(rate * 100).toFixed(1)}%) · latency avg ${avg} ms, p50 ${p50} ms, max ${lat[lat.length - 1]} ms · ${tokens} input tokens ($${((tokens / 1e6) * 0.042).toFixed(5)})\n`);
  assert.ok(rate >= 0.9, `pass rate ${(rate * 100).toFixed(1)}% is below 90%`);
});
