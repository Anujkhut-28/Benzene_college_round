/**
 * Rule-based fast path for the everyday commands.
 *
 * Everything here answers in microseconds without asking the model, so it cuts both the latency of
 * every utterance and the number of billed model requests (a ruled command never reaches the
 * model). Anything not matched here returns null and falls through to the model untouched, so the
 * rules may be as narrow as they like: a false negative only costs a request, a false positive
 * would act on a guess.
 */
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
  { intent: "go_back", re: /^(go |take me |get me )?back$|^(go |get )?back to|^undo( that| this| it)?$|^(go )?previous( page)?$|^previous page$|^back$|^undo$|^previous$|^return( to (the )?previous)?$|^take me back$|^go back( one| 1)?$/ },
  { intent: "go_forward", re: /^(go )?forward$|^redo( that| this| it)?$|^redo$|^forward$|^move forward$/ },
  { intent: "reload", re: /^(re)?load( the (page|website|site))?$|^refresh( the (page|website|site|tab))?$|^refresh$|^reload$|^reload page$|^refresh page$|^reload( it| this| the site)?$|^refresh( it| this)$/ },
  { intent: "open_new_tab", re: /^(open|make|start|give me|give me a|launch|open up)?\s*(a |another |one more |new )?new (browser |private |incognito )?(tab|window)( please)?$|^(open|start|make)?\s*(another|one more|a new) (browser |private |incognito )?(tab|window)$/ },
  { intent: "close_tab", re: /^(close|quit|exit|shut)( this| that| the| my)? (tab|window|page)$|^close (it|that)$|^shut (this|that|the) (tab|window|page)$/ },
  { intent: "switch_tab", re: /^(next|previous|prev|other|another|second|last|first|third) tab$|^switch tab$|^switch (to )?(the )?(next|previous|other|first|second|last) tab$|^go to the other tab$|^change tab$|^switch (windows|tabs)$|^go (to )?(next|previous|prev) tab$/ },
  { intent: "press_enter", re: /^(press |hit |push |tap )?(enter|return)( key)?$|^submit( it| that| this)?$|^hit submit$|^press submit$|^go$|^send (it|that)$/ },
  { intent: "scroll_down", re: /^(scroll |page |swipe |jump )?down( a (bit|little))?$|^scroll down$|^go (further |farther |down )*down$|^down( a (bit|little))?$|^more$|^keep going$|^continue down$|^see more$|^show more$|^scroll to the (bottom|end)$|^go to the (bottom|end)$|^bottom of the page$|^jump to the (bottom|end)$|^all the way down$|^read (more|on)$|^next( screen| page)?$/ },
  { intent: "scroll_up", re: /^(scroll |page |swipe |jump )?up( a (bit|little))?$|^scroll up$|^go (back )?up$|^up( a (bit|little))?$|^less$|^keep going up$|^continue up$|^scroll to the top$|^go to the top$|^back to the top$|^jump to the top$|^top of the page$|^read (less|earlier)$|^previous (screen| page)$/ },
  { intent: "navigate_url", url: "https://example.com/", re: /^(go |take me )?back to (the )?(home|homepage|start)$|^go home$|^take me home$|^go to (the )?home ?page$|^home page$/ },
  // Number every clickable thing on the page so the user can aim by number instead of by name.
  // The most reliable click available: it does not depend on the model matching words to an element.
  { intent: "show_numbers", re: /^(show|list|give me|display|put)?\s*(me\s+)?(the\s+)?(numbers?|numbering|numbered list)$|^number (the )?(page|links|buttons|things|items|options)$|^number (everything|it all|them)$|^show (me )?(the )?links$|^what (can|do) i click$|^list (me )?(the )?(links|buttons|things|items|options)$/ },
  { intent: "hide_numbers", re: /^(hide|clear|remove|get rid of|take away)\s*(the )?(numbers|numbering|numbered list)$|^hide (the )?numbers$|^no numbers$|^numbers off$/ },
  // The mic is always on by default, which picks up the room. Let the user turn it off without
  // reaching for the mouse, and back on again when they are ready.
  { intent: "stop_listening", re: /^(stop|pause|halt|shut up|be quiet|quiet)\s*(listening|the mic|hearing me|voice)?$|^stop listening$|^pause listening$|^stop hearing me$|^(mute|unlisten)$/ },
  { intent: "start_listening", re: /^(start|resume|unpause|continue)\s*(listening|the mic|hearing me|voice)?$|^start listening$|^resume listening$|^listen( again)?$|^wake up$/ },
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

const NAV_VERBS = "go to|open|visit|take me to|navigate to|browse|show me|load|start|check out|head to";

// Destinations with no SITE_HOME entry: the rule carries the URL itself, so code still owns every
// address and Jev never sees one. Spoken on its own after any nav verb ("open imdb", "take me to
// news ycombinator"), matched against the destination words, not the whole utterance.
const EXTRA_SITES = [
  ["https://chatgpt.com/", /^(the )?chat ?gpt( app| site)?$/],
  ["https://claude.ai/", /^claude( ai)?$/],
  ["https://www.perplexity.ai/", /^perplexity( ai)?$/],
  ["https://www.linkedin.com/", /^linked ?in$/],
  ["https://stackoverflow.com/", /^stack ?overflow$/],
  ["https://www.netflix.com/", /^netflix$/],
  ["https://www.google.com/maps", /^(google )?maps$/],
  ["https://web.whatsapp.com/", /^what ?s ?app$/],
  ["https://www.imdb.com/", /^im ?db$/],
  ["https://news.ycombinator.com/", /^(news )?y ?combinator( news)?$/],
  ["https://www.facebook.com/", /^face ?book$/],
  ["https://www.instagram.com/", /^insta ?gram$/],
  ["https://www.pinterest.com/", /^pinterest$/],
  ["https://web.telegram.org/", /^tele ?gram$/],
  ["https://open.spotify.com/", /^spotify$/],
  ["https://mail.google.com/", /^(google )?(g ?mail|mail)$/],
  ["https://drive.google.com/", /^(google )?drive$/],
  ["https://docs.google.com/", /^(google )?docs?$/],
  ["https://www.notion.so/", /^notion$/],
  ["https://www.figma.com/", /^figma$/],
  ["https://app.slack.com/", /^slack$/],
  ["https://translate.google.com/", /^(google )?translate$/],
  ["https://www.weather.com/", /^weather$/],
  ["https://arxiv.org/", /^arxiv$/],
  ["https://medium.com/", /^medium$/],
  ["https://www.yelp.com/", /^yelp$/],
  ["https://www.walmart.com/", /^wal ?mart$/],
  ["https://www.ebay.com/", /^e ?bay$/],
  ["https://www.booking.com/", /^booking( com)?$/],
  ["https://www.nytimes.com/", /^(the )?new ?york ?times$|^n ?y ?t$/],
  ["https://www.bbc.com/", /^bbc( news)?$/],
  ["https://www.coursera.org/", /^coursera$/],
  ["https://www.khanacademy.org/", /^khan ?academy$/],
  ["https://caniuse.com/", /^can ?i ?use$/],
  ["https://developer.mozilla.org/", /^(mdn|mozilla developer( network)?)$/],
  ["https://pypi.org/", /^pypi$/],
  ["https://www.npmjs.com/", /^npm(js)?$/],
  ["https://vercel.com/", /^vercel$/],
  ["https://www.netlify.com/", /^netlify$/],
  ["https://dash.cloudflare.com/", /^cloud ?flare$/],
  ["https://tailwindcss.com/", /^tail ?wind( css)?$/],
  ["https://react.dev/", /^react(js| dev)?$/],
  ["https://openai.com/", /^open ?ai$/],
  ["https://frcrce.ac.in/", /^frcrce$/],
// the name regexes above are anchored; unwrap them so they can sit inside the full-phrase pattern
].map(([url, name]) => ({ url, re: new RegExp(`^(?:${NAV_VERBS}) (?:the )?${name.source.replace(/^\^/, "").replace(/\$$/, "")}$`) }));

const VERB_TO_SITE = new RegExp(`^(?:${NAV_VERBS})\\s+(the\\s+)?`);

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
  "im ?db",
  "stack ?overflow",
  "news",
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

  const sm = t.match(new RegExp(`^(?:search|look up|lookup|google|find|look for)(?: on)? (${SEARCH_SITES})(?: for)? (.+)$`))
    || t.match(new RegExp(`^(?:search|look up|lookup|google|find|look for)(?: on)?(?: for)? (.+)$`));
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

  const cm = t.match(/^(?:click|press|tap|select|choose|hit|open|activate|go to|tap on|pick|pick out)\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (cm) {
    const what = cm[1].trim();
    const ordinal = Object.entries(ORDINALS).find(([w]) => new RegExp(`\\b${w}\\b`).test(what));
    out.intent = high("click_element");
    if (ordinal) out.ordinal = ordinal[1];
    const quoted = what.match(/"([^"]+)"|'([^']+)'/);
    out.element_hint = (quoted ? quoted[1] || quoted[2] : what).trim();
    return out;
  }

  const tm = t.match(/^(?:type|enter|write|put|fill in|fill|type in|type my)\s+(.+?)(?:\s+(?:in|into|on)\s+the\s+(.+))?$/);
  if (tm) {
    const text = tm[1].trim();
    if (text && !/^(in|into|the|a|an|my|it|this|that)$/.test(text)) {
      out.intent = high("type_into_field");
      out.text_span = { type: "choice", choice: text, confidence: 0.9, probabilities: { [text]: 0.9, none: 0.1 } };
      if (tm[2]) out.field_hint = tm[2].trim();
      return out;
    }
  }

  if (/^(confirm|yes( do it)?|go ahead|approve|do it|confirm that|yes please do it|yeah|yep|sure( do it)?|affirmative|confirm it)$/.test(t)) {
    out.intent = high("confirm");
    return out;
  }
  if (/^(cancel|never ?mind|stop|no|abort|forget it|dont|do not|nevermind that|stop that|cancel that|no thanks|nope)$/.test(t)) {
    out.intent = high("cancel");
    return out;
  }

  return null;
}