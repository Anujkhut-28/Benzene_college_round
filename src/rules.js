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
  { intent: "scroll_down", re: /^(scroll |page |swipe |jump )?down( a (bit|little))?$|^scroll down$|^go (further |farther |down )*down$|^down( a (bit|little))?$|^more$|^keep going$|^continue down$|^see more$|^show more$|^scroll to the (bottom|end)$|^go to the (bottom|end)$|^bottom of the page$|^jump to the (bottom|end)$|^all the way down$|^read (more|on)$|^next( screen| page)?$|^scroll a (bit|little)$|^down a (bit|little)$/ },
  { intent: "scroll_up", re: /^(scroll |page |swipe |jump )?up( a (bit|little))?$|^scroll up$|^go (back )?up$|^up( a (bit|little))?$|^less$|^keep going up$|^continue up$|^scroll to the top$|^go to the top$|^back to the top$|^jump to the top$|^top of the page$|^read (less|earlier)$|^previous (screen| page)$|^scroll a (bit|little)$|^up a (bit|little)$/ },
  { intent: "navigate_url", url: "https://example.com/", re: /^(go |take me )?back to (the )?(home|homepage|start)$|^go home$|^take me home$|^go to (the )?home ?page$|^home page$/ },
  // Number every clickable thing on the page so the user can aim by number instead of by name.
  // The most reliable click available: it does not depend on the model matching words to an element.
  { intent: "show_numbers", re: /^(show|list|give me|display|put)?\s*(me\s+)?(the\s+)?(numbers?|numbering|numbered list)$|^number (the )?(page|links|buttons|things|items|options)$|^number (everything|it all|them)$|^show (me )?(the )?links$|^what (can|do) i click$|^list (me )?(the )?(links|buttons|things|items|options)$/ },
  { intent: "hide_numbers", re: /^(hide|clear|remove|get rid of|take away)\s*(the )?(numbers|numbering|numbered list)$|^hide (the )?numbers$|^no numbers$|^numbers off$/ },
  // The mic is always on by default, which picks up the room. Let the user turn it off without
  // reaching for the mouse, and back on again when they are ready.
  { intent: "stop_listening", re: /^(stop|pause|halt|shut up|be quiet|quiet)\s*(listening|the mic|hearing me|voice)?$|^stop listening$|^pause listening$|^stop hearing me$|^(mute|unlisten)$/ },
  { intent: "start_listening", re: /^(start|resume|unpause|continue)\s*(listening|the mic|hearing me|voice)?$|^start listening$|^resume listening$|^listen( again)?$|^wake up$/ },
  // Keyboard control. Enter was the only key reachable by voice, which makes filling in a
  // form impossible: there is no way to get between fields, fix a mistake, or dismiss a dialog.
  { intent: "press_key", key: "Tab", re: /^(press |hit |push |tap )?tab( key)?$|^tab (over|on)( to the)? next( (field|box|one))?$|^next field$|^move to the next (field|box)$/ },
  { intent: "press_key", key: "Escape", re: /^(press |hit |push |tap )?escape( key)?$|^escape$|^dismiss( this| that| the (dialog|popup|menu))?$|^close (the |this )?(dialog|popup|menu)$|^cancel that$|^get rid of (that|this)$/ },
  { intent: "press_key", key: "Backspace", re: /^(press |hit |push |tap )?back ?space( key)?$|^back ?space$|^delete (the |that )?(last|previous) (character|letter|word)$|^erase (a|one|the last) (character|letter)$/ },
  { intent: "press_key", key: "Delete", re: /^(press |hit |push |tap )?delete( key)?$|^delete (the |that )?(next|following) (character|letter)$/ },
  // Bare "up"/"down"/"left"/"right" already scroll, and they match first. The caret keys
  // therefore require the word "arrow" or an explicit "press" - otherwise these rules would be
  // dead code shadowed by the scroll rules above.
  { intent: "press_key", key: "ArrowDown", re: /^(down arrow|arrow down)( key)?$|^(press |hit |push |tap )down( key)?$/ },
  { intent: "press_key", key: "ArrowUp", re: /^(up arrow|arrow up)( key)?$|^(press |hit |push |tap )up( key)?$/ },
  { intent: "press_key", key: "ArrowLeft", re: /^(left arrow|arrow left)( key)?$|^(press |hit |push |tap )left( key)?$/ },
  { intent: "press_key", key: "ArrowRight", re: /^(right arrow|arrow right)( key)?$|^(press |hit |push |tap )right( key)?$/ },
  { intent: "press_key", key: "Home", re: /^(press |hit |push |tap )?home( key)?$|^(go|jump|move) to (the )?(start|beginning)( of the line)?$/ },
  { intent: "press_key", key: "End", re: /^(press |hit |push |tap )?end( key)?$|^(go|jump|move) to (the )?end( of the line)?$/ },
  { intent: "press_key", key: " ", re: /^(space|space ?bar)( key)?$|^type (a )?space$/ },
  // Clipboard and editing shortcuts.
  { intent: "press_key", key: "Control+a", re: /^select all$|^select everything$|^(press |hit )?control a$|^highlight everything$/ },
  { intent: "press_key", key: "Control+c", re: /^copy( (that|this|it))?$|^(press |hit )?control c$/ },
  { intent: "press_key", key: "Control+v", re: /^paste( (that|this|it))?$|^(press |hit )?control v$/ },
  { intent: "press_key", key: "Control+x", re: /^cut( (that|this|it))?$|^(press |hit )?control x$/ },
  // Bare "undo"/"redo" already belong to the page-history rules above, and they match first,
  // so only the explicit chords are reachable here. Left as chords rather than stealing the words.
  { intent: "press_key", key: "Control+z", re: /^(press |hit )?control z$/ },
  { intent: "press_key", key: "Control+y", re: /^(press |hit )?control y$/ },
  // Clearing the whole field in one go.
  { intent: "clear_field", re: /^(?:clear|empty|wipe|reset|start over)(?: the| that| this)?(?: box| field| input| search box)?$|^clear (?:it|that text|what i said|what i typed)$|^start (?:that|the) (?:over|again)$/ },
  // Click flavours. These carry a modifier the plain click cannot express. They still report
  // intent "click_element" so the model is asked for the target exactly as it is for a plain
  // click - inventing a new intent name would leave the target unresolved.
  { intent: "click_element", how: "right", re: /^(right ?click|right click|context menu|open the context menu|secondary click)( on| the)? .+$/ },
  { intent: "click_element", how: "double", re: /^(double ?click|doubleclick|double tap)( on| the)? .+$/ },
  { intent: "click_element", how: "hover", re: /^(hover|point at|point to|move (the )?(cursor )?over|show (the )?tooltip for)( on| at| the)? .+$/ },
  { intent: "click_element", how: "new_tab", re: /^(open|click|activate) .+ (in|on) (a )?new tab$|^open .+ in a new tab$|^new tab (for|with) .+$/ },
  { intent: "click_element", how: "drag", re: /^drag .+ (onto|to|over|into|towards) .+$|^drag .+ (right|left|up|down)$/ },
  // Horizontal scrolling, and scrolling that keeps going until told to stop.
  { intent: "scroll_left", re: /^(scroll |page |swipe )?left( a (bit|little))?$|^scroll left$|^go left$|^left( a bit)?$|^more to the left$/ },
  { intent: "scroll_right", re: /^(scroll |page |swipe )?right( a (bit|little))?$|^scroll right$|^go right$|^right( a bit)?$|^more to the right$/ },
  { intent: "scroll_stop", re: /^(stop|halt|pause|quit)\s*(scrolling|rolling)$|^stop (scrolling|that scrolling|rolling)$|^that'? ?s enough$|^enough scrolling$|^not (any )?more$|^hold on$|^wait$/ },
  // Continuous scrolling: keep going until "stop". Separate from the one-shot "scroll down"
  // so that saying "more" does not suddenly start moving on its own.
  { intent: "scroll_start", re: /^keep scrolling( down)?$|^keep scrolling (down|up|left|right)$|^start scrolling( down| up)?$|^scroll (away|on) (down|up)$|^keep going( down| up)?$/ },
  // Everyday commands that were missing entirely.
  { intent: "switch_tab", re: /^(go|switch|jump) to tab (\d+|one|two|three|four|five|six|seven|eight|nine|ten)$|^tab (\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/ },
  { intent: "reopen_tab", re: /^(reopen|restore|undo close|bring back)( (the|that|this|last))?( closed| last)? tab$|^reopen closed tab$|^bring back that tab$|^open the last closed tab$/ },
  { intent: "close_other_tabs", re: /^close (the )?other tabs$|^close (all )?(the )?others$|^close everything else$|^only (keep|leave) this tab$/ },
  { intent: "find_on_page", re: /^(find|search) (on |in )?(this |the )?page$|^find on page$|^search this page$|^look (for|up) on (this|the) page$/ },
  { intent: "zoom_in", re: /^(zoom|magnify) in$|^make (it|text|bigger|larger)$|^bigger$|^larger text$/ },
  { intent: "zoom_out", re: /^(zoom|shrink) out$|^make (it|text|smaller)$|^smaller$|^smaller text$/ },
  { intent: "zoom_reset", re: /^(reset|normal) zoom$|^zoom (reset|normal|100)$|^actual size$/ },
  { intent: "read_page", re: /^read (this|the|it all|this whole) page( (aloud|out loud|to me))?$|^read (it )?(aloud|out loud)$|^what does (this|the) page say$/ },
  { intent: "repeat_last", re: /^(repeat|again|do that again|one more time|once more|do it again|same again)$|^repeat (that|it)( again)?$/ },
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

const TABS_ONE_TO_TEN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** "tab 3" / "go to the third tab" -> 3. Returns null when no tab was named. */
function parseTabNumber(t) {
  const m = t.match(/\btab (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!m) return null;
  const v = m[1];
  return /^\d+$/.test(v) ? Number(v) : TABS_ONE_TO_TEN[v] ?? null;
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
    // "go to tab 3" needs an ordinal, not a direction.
    if (rule.intent === "switch_tab") {
      const n = parseTabNumber(t);
      if (n != null) {
        out.tab_index = n;
        out.tab_direction = high("none");
      }
    }
    if (rule.url) {
      out.intent = high(rule.intent);
      out.url_span = { type: "choice", choice: rule.url, confidence: 0.9, probabilities: { [rule.url]: 0.9, none: 0.1 } };
      return out;
    }
    // Keys travel as a target-free payload; code owns the mapping so the model never picks them.
    if (rule.key) out.press_key = { key: rule.key };
    if (rule.intent === "scroll_start") {
      out.scroll_direction = /(up|left|right)/.exec(t)?.[1] ?? "down";
    }
    // Click flavours likewise: the intent stays click_element so the model still resolves a
    // target, and the flavour rides along for the policy to attach to the action.
    if (rule.how) {
      out.how = rule.how;
      // "drag the file onto the trash" - the drop target is matched by text in the page rather
      // than asking the model for a second element, which it cannot answer in one pass.
      const drag = t.match(/^drag .+? (?:onto|to|over|into|towards) (.+)$/);
      if (drag) out.drop_text = drag[1];
      const dir = t.match(/^drag .+? (right|left|up|down)$/);
      if (dir) out.drag_dir = dir[1];
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