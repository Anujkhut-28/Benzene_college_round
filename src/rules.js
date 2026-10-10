const FILLER = /\b(please|thanks|thank you|now|okay|ok|um|uh|hey|lets|let us)\b/g;

import { SITE_PATHS } from "./constants.js";

export function normalizeCommand(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RULES = [
  { intent: "go_back", re: /^(go |take me )?back$|^(go )?back to|^undo( that| this| it)?$|^(go )?previous( page)?$|^previous page$|^back$|^undo$|^previous$/ },
  { intent: "go_forward", re: /^(go )?forward$|^redo( that| this| it)?$|^redo$|^forward$/ },
  { intent: "reload", re: /^(re)?load( the (page|website|site))?$|^refresh( the (page|website|site))?$|^refresh$|^reload$|^reload page$|^refresh page$/ },
  { intent: "open_new_tab", re: /^(open|make|start|give me|give me a)?\s*(a |another |one more )?new (browser )?(tab|window)( please)?$/ },
  { intent: "close_tab", re: /^(close|quit|exit)( this| the)? (tab|window|page)$|^close tab$|^close this tab$|^close the tab$/ },
  { intent: "switch_tab", re: /^(next|previous|prev|other|another|second) tab$|^switch tab$|^switch (to )?(the )?(next|previous|other) tab$|^go to the other tab$|^change tab$/ },
  { intent: "press_enter", re: /^(press |hit |push )?(enter|return)( key)?$|^submit( it)?$|^hit submit$|^press submit$/ },
  { intent: "scroll_down", re: /^(scroll |page |swipe )?down( a (bit|little))?$|^scroll down$|^go (further |farther )?down$|^down( a (bit|little))?$|^more$|^keep going$|^continue down$|^see more$|^scroll to the (bottom|end)$|^go to the (bottom|end)$|^bottom of the page$|^jump to the (bottom|end)$|^all the way down$/ },
  { intent: "scroll_up", re: /^(scroll |page |swipe )?up( a (bit|little))?$|^scroll up$|^go (back )?up$|^up( a (bit|little))?$|^less$|^keep going up$|^continue up$|^scroll to the top$|^go to the top$|^back to the top$|^jump to the top$|^top of the page$/ },
  { intent: "navigate_url", url: "https://example.com/", re: /^(go |take me )?back to (the )?(home|homepage|start)$|^go home$|^take me home$|^go to (the )?home ?page$/ },
];

const SITE_WORDS = {
  wikipedia: /\b(wikipedia|wiki|encyclopedia|encyclopaedia)\b/,
  youtube: /\b(youtube|yt|you tube)\b/,
  google: /\bgoogle\b/,
  duckduckgo: /\bduck ?duck ?go\b/,
  github: /\b(github|git ?hub)\b/,
  amazon: /\b(amazon|shopping|shop)\b/,
  reddit: /\breddit\b/,
  twitter_x: /\b(twitter|tweet)\b/,
  hacker_news: /\b(hacker ?news|hn)\b/,
  example_com: /\bexample (dot )?com\b/,
};

const EXTRA_SITES = [
  { url: "https://chatgpt.com/", re: /^(open|go to|visit) chat ?gpt$/ },
  { url: "https://claude.ai/", re: /^(open|go to|visit) claude$/ },
  { url: "https://www.perplexity.ai/", re: /^(open|go to|visit) perplexity$/ },
  { url: "https://www.linkedin.com/", re: /^(open|go to|visit) linked ?in$/ },
  { url: "https://stackoverflow.com/", re: /^(open|go to|visit) stack ?overflow$/ },
  { url: "https://www.netflix.com/", re: /^(open|go to|visit) netflix$/ },
  { url: "https://www.google.com/maps", re: /^(open|go to|visit) (google )?maps$/ },
  { url: "https://web.whatsapp.com/", re: /^(open|go to|visit) whatsapp$/ },
];

const VERB_TO_SITE = /^(go to|open|visit|take me to|navigate to|browse|show me|load|start|check out|head to)\s+(the\s+)?/;

const SEARCH_SITES = [
  "google",
  "duck ?duck ?go",
  "youtube",
  "wikipedia",
  "github",
  "amazon",
  "reddit",
  "twitter",
  "hacker ?news",
  "the web",
  "internet",
  "online",
  "wiki",
  "hn",
]
  .sort((a, b) => b.length - a.length)
  .map((s) => `(?:${s})`)
  .join("|");

const ORDINAL_WORDS_TEST = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last|final)\b/;

const ORDINALS = {
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
  last: -1,
  final: -1,
};

function high(choice) {
  return { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9, none: 0.1 } };
}
function noul(v) {
  return { type: "noul", noul: v, probability_true: v, probability_false: 1 - v };
}

export function recognize(transcript, { site: snapshotSite = "generic" } = {}) {
  const t = normalizeCommand(transcript);
  if (!t || t.split(" ").length > 12) return null;

  const out = {
    site: high("none"),
    complete: noul(0.9),
    is_command: noul(0.9),
    destructive: noul(0.1),
    scroll_amount: { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 } },
    tab_direction: high("none"),
  };

  if (/to the (bottom|end)|bottom of the page|^all the way down$/.test(t)) {
    out.scroll_amount = { type: "score", score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } };
  } else if (/\b(a (bit|little)|slightly|bit)\b/.test(t)) {
    out.scroll_amount = { type: "score", score: 0, probabilities: { 0: 0.7, 1: 0.2, 2: 0.1 } };
  }

  for (const rule of RULES) {
    if (!rule.re.test(t)) continue;
    if (rule.intent === "switch_tab") {
      out.tab_direction = /^(previous|prev|last|back)/.test(t) ? high("previous") : high("next");
    }
    if (rule.url) {
      out.intent = high(rule.intent);
      out.url_span = { type: "choice", choice: rule.url, confidence: 0.9, probabilities: { [rule.url]: 0.9, none: 0.1 } };
      return out;
    }
    out.intent = high(rule.intent);
    return out;
  }

  const navVerb = t.match(VERB_TO_SITE);
  if (navVerb) {
    const dest = t.slice(navVerb[0].length).trim();
    if (dest) {
      for (const [id, re] of Object.entries(SITE_WORDS)) {
        if (re.test(dest)) {
          out.intent = high("navigate_url");
          out.site = high(id);
          return out;
        }
      }
      // A bare page name ("shorts", "subscriptions") resolves inside the site named in the same
      // breath, or the one already on screen, or whichever site owns that page name. Only a site
      // that actually has such a page counts, so "open shorts" works from anywhere.
      const siteCandidates = [
        Object.entries(SITE_WORDS).find(([, re]) => re.test(dest))?.[0],
        snapshotSite,
        ...Object.keys(SITE_PATHS),
      ].filter((s, i, arr) => s && !["blank", "generic"].includes(s) && arr.indexOf(s) === i);
      const hit = siteCandidates
        .map((s) => [s, Object.keys(SITE_PATHS[s] || {}).find((k) => new RegExp(`\\b${k}\\b`).test(dest))])
        .find(([, key]) => key);
      if (hit) {
        out.intent = high("navigate_url");
        out.site = high(hit[0]);
        return out;
      }
      for (const extra of EXTRA_SITES) {
        if (extra.re.test(t)) {
          out.intent = high("navigate_url");
          out.url_span = { type: "choice", choice: extra.url, confidence: 0.9, probabilities: { [extra.url]: 0.9, none: 0.1 } };
          return out;
        }
      }
      if (!/^(search|look up|lookup|google|find)\b/.test(dest) && !/^(back|home|top|bottom|next|previous|first|last)$/.test(dest) && !/\b(tab|window|page|link|button|result|item|section)\b/.test(dest) && !ORDINAL_WORDS_TEST.test(dest)) {
        out.intent = high("navigate_url");
        out.site = high("other_named_site");
        return out;
      }
    }
  }

  const sm = t.match(new RegExp(`^(?:search|look up|lookup|google|find)(?: on)? (${SEARCH_SITES})(?: for)? (.+)$`))
    || t.match(new RegExp(`^(?:search|look up|lookup|google|find)(?: on)?(?: for)? (.+)$`));
  if (sm) {
    const withSite = sm.length === 3;
    const siteWord = withSite ? sm[1] : null;
    const query = (withSite ? sm[2] : sm[1] ?? "").trim();
    if (query && !/^(for|up|the|a|an|on|out|about|this|that)$/.test(query)) {
      out.intent = high("search_web");
      if (siteWord) {
        const site = Object.entries(SITE_WORDS).find(([, re]) => re.test(siteWord))?.[0];
        out.site = high(site || "the_web");
      }
      out.text_span = { type: "choice", choice: query, confidence: 0.9, probabilities: { [query]: 0.9, none: 0.1 } };
      return out;
    }
  }

  const cm = t.match(/^(?:click|press|tap|select|choose|hit|open|activate)\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (cm) {
    const what = cm[1].trim();
    const ordinal = Object.entries(ORDINALS).find(([w]) => new RegExp(`\\b${w}\\b`).test(what));
    out.intent = high("click_element");
    if (ordinal) out.ordinal = ordinal[1];
    const quoted = what.match(/"([^"]+)"|'([^']+)'/);
    out.element_hint = (quoted ? quoted[1] || quoted[2] : what).trim();
    return out;
  }

  const tm = t.match(/^(?:type|enter|write|put|fill in|fill)\s+(.+?)(?:\s+(?:in|into|on)\s+the\s+(.+))?$/);
  if (tm) {
    const text = tm[1].trim();
    if (text && !/^(in|into|the|a|an|my|it|this|that)$/.test(text)) {
      out.intent = high("type_into_field");
      out.text_span = { type: "choice", choice: text, confidence: 0.9, probabilities: { [text]: 0.9, none: 0.1 } };
      if (tm[2]) out.field_hint = tm[2].trim();
      return out;
    }
  }

  if (/^(confirm|yes( do it)?|go ahead|approve|do it|confirm that|yes please do it)$/.test(t)) {
    out.intent = high("confirm");
    return out;
  }
  if (/^(cancel|never ?mind|stop|no|abort|forget it|dont|do not)$/.test(t)) {
    out.intent = high("cancel");
    return out;
  }

  return null;
}