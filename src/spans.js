/**
 * Candidate extraction (code, not Jev). Jev never generates text: we over-generate
 * candidate spans from the transcript here, and Jev only *picks* one of them.
 * The chosen option is copied verbatim into the browser.
 */

const TLDS = "com|org|net|io|ai|dev|co|edu|gov|de|uk|us|app|xyz|info|me|tv|ch|at|fr|nl|es|it";

const FILLER_RE = /\b(please|thanks|thank you|now|okay|ok|um|uh|and then)\b/gi;

// Verbs that introduce payload text. Order matters: longer/more specific first.
const TEXT_VERBS = [
  /\b(?:search|look)\s+(?:for|up)\s+/i,
  /\bsearch\s+(?:on\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+for\s+/i,
  /\bsearch\s+/i,
  /\bgoogle\s+/i,
  /\bfind\s+/i,
  /\btype\s+(?:in\s+)?/i,
  /\benter\s+/i,
  /\bwrite\s+/i,
  /\bput\s+/i,
  /\bfill\s+(?:in\s+)?/i,
];

// Trailing destination phrases to strip from a payload: "... into the search box".
const TRAILING_DEST_RE =
  /\s+(?:in|into|on|inside|to)\s+(?:the\s+)?(?:[\w-]+\s+){0,4}?(?:box|field|input|bar|form|textarea|search|wikipedia|youtube|google|duckduckgo|github|amazon|reddit|twitter|x|web)\b.*$/i;

// Leading site phrases: "wikipedia for cats" -> "cats", "on wikipedia cats" (rare)
const LEADING_SITE_RE =
  /^(?:on\s+|in\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+(?:for\s+)?/i;

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(s) {
  return s.replace(FILLER_RE, " ").replace(/\s+/g, " ").replace(/[.,!?]+$/g, "").trim();
}

function pushUnique(list, value) {
  const v = stripFiller(value);
  if (!v) return;
  if (v.length > 120) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  list.push(v);
}

/**
 * Candidate text payloads for type/search intents.
 * Returns [] when the transcript is empty. Order: most likely first.
 */
export function extractTextCandidates(transcript) {
  const t = cleanTranscript(transcript);
  if (!t) return [];
  const out = [];

  // 1. quoted spans
  for (const m of t.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) pushUnique(out, m[1]);

  // 2. text after a payload verb (earliest verb in the sentence first), destination phrase stripped
  const verbMatches = TEXT_VERBS.map((re) => re.exec(t))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  for (const m of verbMatches) {
    let tail = t.slice(m.index + m[0].length);
    tail = tail.replace(LEADING_SITE_RE, "");
    const stripped = tail.replace(TRAILING_DEST_RE, "");
    pushUnique(out, stripped);
    if (stripped !== tail) pushUnique(out, tail);
  }

  // 3. the tail after the first "for"
  const forIdx = t.toLowerCase().indexOf(" for ");
  if (forIdx >= 0) pushUnique(out, t.slice(forIdx + 5).replace(TRAILING_DEST_RE, ""));

  // 4. tail after the first word (covers "type hello")
  const firstSpace = t.indexOf(" ");
  if (firstSpace > 0) pushUnique(out, t.slice(firstSpace + 1).replace(TRAILING_DEST_RE, ""));

  // 5. whole transcript as a last resort
  pushUnique(out, t);

  return out.slice(0, 8);
}

/** Words after a nav verb ("open shorts" -> ["shorts"]) that can name a page inside a site. */
export function extractPathCandidates(transcript) {
  const t = cleanTranscript(transcript).toLowerCase();
  const m = t.match(/^(?:open|go to|go|visit|take me to|show me|load|start|browse|check out|head to|navigate to)\s+(?:the\s+)?(.+)$/);
  if (!m) return [];
  let dest = m[1].trim();
  // Drop a trailing site word: "open youtube shorts" -> "shorts". A leading "my" is kept,
  // because some pages are named with it ("my channel").
  dest = dest.replace(/^(?:on\s+)?(?:youtube|yt|google|duckduckgo|wikipedia|github|amazon|reddit|twitter|x)\b\s*/, "");
  return dest ? [dest] : [];
}

/** "example dot com" -> "example.com"; also lowercases and strips spaces around dots. */
export function normalizeSpokenUrl(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+slash\s+/g, "/")
    .replace(/\bwww\s+/g, "www.")
    .replace(/\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//g, (m) => (m.includes("s") ? "https://" : "http://"));
}

/** Domain-looking spans in the transcript (after spoken-url normalisation). */
export function extractUrlCandidates(transcript) {
  const t = normalizeSpokenUrl(cleanTranscript(transcript));
  if (!t) return [];
  const re = new RegExp(`(?:https?://)?(?:[a-z0-9-]+\\.)+(?:${TLDS})(?:/[^\\s]*)?`, "gi");
  const out = [];
  for (const m of t.matchAll(re)) {
    const v = m[0].replace(/[.,!?]+$/, "");
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
}

export function toHttpUrl(domainish) {
  const v = String(domainish).trim();
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

const CARDINALS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};
// Ordinal suffixes are irregular, so list them rather than deriving them.
const SUFFIX = { 1: "st", 2: "nd", 3: "rd" };

// Numbered overlays badge up to 60 elements, so picking has to work well past five: "click 14"
// and "click twenty three" are the ordinary cases here, not "click three".
const NUMBER_WORDS = (() => {
  const m = {};
  CARDINALS.forEach((w, i) => {
    m[w] = i;
    m[String(i)] = i;
  });
  for (const [w, n] of [...Object.entries(TENS), ...Object.entries(ORDINALS)]) {
    m[w] = n;
    m[`${n}${SUFFIX[n] ?? "th"}`] = n;
  }
  return m;
})();
// Speech-recognizer homophones, only trusted when they are the whole utterance ("to" alone).
const NUMBER_HOMOPHONES = { won: 1, to: 2, too: 2, for: 4 };

/**
 * When numbered candidate overlays are on screen, a bare number ("two", "the second one",
 * "number 3") is a deterministic pick — no need to ask Jev.
 * Returns 1-based index or null.
 */
const PICK_STOPWORDS = new Set([
  "the", "number", "option", "pick", "choose", "select", "click", "take", "that", "please", "link", "item", "result", "go", "with", "on", "yes", "this", "um", "uh",
]);

export function parseCandidatePick(transcript, max = 5) {
  const t = cleanTranscript(transcript).toLowerCase().replace(/[.,!?]/g, "");
  if (!t) return null;
  const meaningful = t.split(" ").filter((w) => !PICK_STOPWORDS.has(w));
  if (meaningful.length === 0 || meaningful.length > 3) return null;

  // A literal digit is unambiguous and must win outright, or "click 14" reads as "one, four".
  for (const w of meaningful) {
    if (/^\d{1,3}$/.test(w)) {
      const n = Number(w);
      return n >= 1 && n <= max ? n : null;
    }
  }

  // Speech says "twenty three"; the recognizer does not hand us "23".
  const words = meaningful.filter((w) => NUMBER_WORDS[w] != null);
  if (words.length === 0) return null;
  let total = 0;
  for (const w of words) {
    const n = NUMBER_WORDS[w];
    if (total === 0) total = n;
    else if (total % 10 === 0 && n < 10) total += n; // twenty + three
    else break;
  }
  if (total >= 1 && total <= max) return total;

  if (meaningful.length === 1) {
    const n = NUMBER_HOMOPHONES[meaningful[0]];
    if (n && n <= max) return n;
  }
  return null;
}
