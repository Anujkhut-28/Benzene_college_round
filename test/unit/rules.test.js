/**
 * Unit tests for the rule-based fast path (src/rules.js) — no network.
 *
 * These rules are what makes the local backend usable: they answer the everyday commands in
 * microseconds instead of one model request per option. The important properties are that they
 * (a) recognise the documented commands, and (b) return null for anything else, so an unrecognised
 * utterance still falls through to the model rather than being guessed at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognize, normalizeCommand } from "../../src/rules.js";

const intentOf = (t) => recognize(t)?.intent?.choice ?? null;
const siteOf = (t) => recognize(t)?.site?.choice ?? null;

test("recognizes the closed-set commands", () => {
  const cases = {
    "go back": "go_back",
    back: "go_back",
    "undo that": "go_back",
    "go forward": "go_forward",
    reload: "reload",
    "refresh the page": "reload",
    "open a new tab": "open_new_tab",
    "new tab": "open_new_tab",
    "close this tab": "close_tab",
    "next tab": "switch_tab",
    "press enter": "press_enter",
    "scroll down": "scroll_down",
    "scroll down a bit": "scroll_down",
    "scroll to the bottom": "scroll_down",
    "scroll up": "scroll_up",
    "scroll to the top": "scroll_up",
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(intentOf(text), want, `"${text}"`);
});

test("recognizes navigation to a named site", () => {
  assert.equal(intentOf("go to wikipedia"), "navigate_url");
  assert.equal(siteOf("go to wikipedia"), "wikipedia");
  assert.equal(siteOf("open youtube"), "youtube");
  assert.equal(siteOf("take me to github"), "github");
  assert.equal(siteOf("visit the encyclopedia"), "wikipedia");
  // an unknown destination is still a navigation; code owns the URL
  assert.equal(siteOf("go to example dot com"), "example_com");
});

test("recognizes a named page inside a site ('open shorts')", () => {
  // Regression: "open shorts" used to be read as an unknown brand, so the policy waited for a
  // site that was never coming and the command silently did nothing.
  for (const said of ["open shorts", "go to shorts", "open the shorts"]) {
    assert.equal(intentOf(said), "navigate_url", said);
  }
  assert.equal(recognize("open shorts", { site: "youtube" })?.site?.choice, "youtube");
  // A page name resolves against whichever site owns it, even from an unrelated page.
  assert.equal(recognize("open shorts", { site: "example_com" })?.site?.choice, "youtube");
  assert.equal(recognize("open shorts", { site: "generic" })?.site?.choice, "youtube");
  // An unknown destination is still not a known page: it must fall through, not guess.
  assert.equal(recognize("open some random site", { site: "youtube" })?.site?.choice, "other_named_site");
});

test("recognizes search, with and without a named site", () => {
  assert.equal(intentOf("search for alan turing"), "search_web");
  assert.equal(intentOf("google cheap flights"), "search_web");
  assert.equal(intentOf("look up typesafe jev"), "search_web");
  assert.equal(siteOf("search youtube for lofi beats"), "youtube");
  assert.equal(siteOf("search for alan turing"), "none", "no site named => the default engine");
});

test("recognizes click and type, leaving the target to the model", () => {
  assert.equal(intentOf("click the first result"), "click_element");
  assert.equal(intentOf("press the more information link"), "click_element");
  assert.equal(intentOf("type hello world into the search box"), "type_into_field");
});

test("recognizes confirm and cancel", () => {
  assert.equal(intentOf("confirm"), "confirm");
  assert.equal(intentOf("go ahead"), "confirm");
  assert.equal(intentOf("cancel"), "cancel");
  assert.equal(intentOf("never mind"), "cancel");
});

test("returns null for chit-chat and anything it is not confident about", () => {
  for (const t of [
    "so anyway I think we should get lunch",
    "um",
    "the weather is nice",
    "what do you think about the new laptop they showed me at the conference yesterday",
  ]) {
    assert.equal(recognize(t), null, `"${t}" must fall through to the model`);
  }
});

test("does not treat a partial phrase as a finished command", () => {
  // "go to" alone has no destination; the model (and the completeness gate) should see it.
  assert.equal(recognize("go to"), null);
  assert.equal(recognize("search for"), null);
});

test("ignores filler words but still matches the command underneath", () => {
  assert.equal(intentOf("okay please scroll down"), "scroll_down");
  assert.equal(intentOf("um go back"), "go_back");
});

test("every recognised command reports itself as a command, complete and non-destructive", () => {
  const r = recognize("go to wikipedia");
  assert.ok(r.is_command.noul >= 0.5, "clears T.isCommand");
  assert.ok(r.complete.noul >= 0.6, "clears T.complete");
  assert.ok(r.destructive.noul < 0.5, "navigation is not destructive");
  // the policy reads these directly, so the shape must match what it expects
  assert.equal(r.intent.type, "choice");
  assert.equal(typeof r.intent.confidence, "number");
  assert.equal(r.scroll_amount.type, "score");
});

test("scroll amount distinguishes a little from all the way", () => {
  assert.equal(recognize("scroll down a bit").scroll_amount.score, 0);
  assert.equal(recognize("scroll down").scroll_amount.score, 1);
  assert.equal(recognize("scroll to the bottom").scroll_amount.score, 2);
});

test("normalizeCommand lowercases, strips punctuation and filler", () => {
  assert.equal(normalizeCommand("  Go Back, please!  "), "go back");
  assert.equal(normalizeCommand("um, open YouTube."), "open youtube");
});

test("recognizes extra destinations that are not in the site list", () => {
  assert.equal(siteOf("open claude"), "none");
  assert.equal(recognize("open claude").url_span.choice, "https://claude.ai/");
  assert.equal(recognize("open chatgpt").url_span.choice, "https://chatgpt.com/");
  assert.equal(recognize("go to stack overflow").url_span.choice, "https://stackoverflow.com/");
  assert.equal(recognize("open linked in").url_span.choice, "https://www.linkedin.com/");
});

test("a navigation rule always carries a URL, so it can never wait forever", () => {
  for (const t of ["go home", "go to wikipedia", "open claude", "open youtube"]) {
    const r = recognize(t);
    assert.equal(r.intent.choice, "navigate_url", t);
    const hasDestination = r.site.choice !== "none" || Boolean(r.url_span);
    assert.ok(hasDestination, `"${t}" must resolve to a site or a URL, got neither`);
  }
});

test("recognizes the added phrasings and destinations", () => {
  assert.equal(intentOf("switch to the last tab"), "switch_tab");
  assert.equal(intentOf("open another tab"), "open_new_tab");
  assert.equal(intentOf("read on"), "scroll_down");
  assert.equal(intentOf("yep"), "confirm");
  assert.equal(intentOf("nope"), "cancel");
  assert.equal(intentOf("look for cheap flights"), "search_web");
  assert.equal(intentOf("pick the second link"), "click_element");
  assert.equal(intentOf("type in my email"), "type_into_field");
  assert.equal(recognize("open imdb").url_span.choice, "https://www.imdb.com/");
  assert.equal(recognize("take me to news ycombinator").url_span.choice, "https://news.ycombinator.com/");
  assert.equal(recognize("visit can i use").url_span.choice, "https://caniuse.com/");
  assert.equal(recognize("go to frcrce").url_span.choice, "https://frcrce.ac.in/");
});

test("recognizes ordinals for element picking", () => {
  assert.equal(recognize("click the first result").ordinal, 0);
  assert.equal(recognize("click the second link").ordinal, 1);
  assert.equal(recognize("click the third result").ordinal, 2);
  assert.equal(recognize("click the last link").ordinal, -1);
  assert.equal(recognize("click sign in").ordinal, undefined);
  assert.equal(recognize("click the sixth result").ordinal, 5);
  assert.equal(recognize("click the tenth result").ordinal, 9);
});

test("'play the Nth video' picks a video by position, not by element index", () => {
  const cases = {
    "play first video": 0,
    "play the second video": 1,
    "watch the third video": 2,
    "play the 4th video": 3,
    "play the tenth video": 9,
    "Play the 2nd video, please.": 1,
    "play last video": -1,
    "watch the second video on youtube": 1,
    "play first youtube video": 0,
  };
  for (const [said, index] of Object.entries(cases)) {
    const r = recognize(said, { site: "youtube" });
    assert.ok(r, `"${said}" should be recognised`);
    assert.equal(r.intent.choice, "play_video", said);
    assert.equal(r.video_index, index, said);
  }
});

test("'play video' rules stay narrow rather than guessing which video", () => {
  for (const said of ["play video", "play the video", "play guitar", "play piano"]) {
    const r = recognize(said, { site: "youtube" });
    assert.ok(!r || r.intent.choice !== "play_video", `"${said}" must not be treated as a numbered video`);
  }
  assert.equal(intentOf("click the first result"), "click_element");
  assert.equal(intentOf("search for cats"), "search_web");
  assert.equal(intentOf("go to youtube"), "navigate_url");
});

test("bare pause and resume drive the media, not the microphone", () => {
  const mediaOf = (t) => {
    const r = recognize(t, { site: "spotify" });
    return r?.intent?.choice === "media" ? r.media_op : r?.intent?.choice ?? null;
  };
  assert.equal(mediaOf("pause"), "pause");
  assert.equal(mediaOf("pause the video"), "pause");
  assert.equal(mediaOf("pause music"), "pause");
  assert.equal(mediaOf("freeze"), "pause");
  assert.equal(mediaOf("resume"), "play");
  assert.equal(mediaOf("resume the video"), "play");
  assert.equal(mediaOf("unpause"), "play");
  assert.equal(mediaOf("skip"), "next");
  assert.equal(mediaOf("next track"), "next");
  assert.equal(mediaOf("previous track"), "previous");
  assert.equal(mediaOf("volume up"), "volume_up");
  assert.equal(mediaOf("louder"), "volume_up");
  assert.equal(mediaOf("mute"), "mute");
  assert.equal(mediaOf("unmute"), "mute");
});

test("'pause listening' still reaches the microphone, and scroll words still scroll", () => {
  const mediaOf = (t) => {
    const r = recognize(t, { site: "spotify" });
    return r?.intent?.choice === "media" ? r.media_op : r?.intent?.choice ?? null;
  };
  assert.equal(intentOf("pause listening"), "stop_listening");
  assert.equal(intentOf("stop listening"), "stop_listening");
  assert.equal(intentOf("resume listening"), "start_listening");
  assert.equal(intentOf("pause scrolling"), "scroll_stop");
  assert.equal(mediaOf("pause the mic"), "stop_listening");
  assert.equal(mediaOf("mute the mic"), "stop_listening");
  assert.equal(mediaOf("mute listening"), "stop_listening");
  assert.equal(intentOf("continue"), "start_listening");
  assert.equal(intentOf("next"), "scroll_down");
  assert.equal(intentOf("previous"), "go_back");
});

test("'show numbers' numbers the page however it is phrased", () => {
  for (const p of [
    "show numbers",
    "show me the numbers",
    "show the numbers",
    "show number",
    "number the page",
    "number the links",
    "number the buttons",
    "number everything",
    "show the numbered list",
    "give me the numbers",
    "show me the links",
    "list the links",
    "list the buttons",
    "what can i click",
  ]) {
    assert.equal(intentOf(p), "show_numbers", `"${p}" should ask for the page to be numbered`);
  }
  for (const p of ["hide numbers", "hide the numbers", "clear the numbers", "no numbers", "numbers off"]) {
    assert.equal(intentOf(p), "hide_numbers", `"${p}" should clear the numbering`);
  }
});

test("everyday tab, page and repeat commands are recognised", () => {
  assert.equal(intentOf("go to tab 3"), "switch_tab");
  assert.equal(intentOf("tab two"), "switch_tab");
  assert.equal(intentOf("reopen closed tab"), "reopen_tab");
  assert.equal(intentOf("restore that tab"), "reopen_tab");
  assert.equal(intentOf("close the other tabs"), "close_other_tabs");
  assert.equal(intentOf("close everything else"), "close_other_tabs");
  assert.equal(intentOf("find on page"), "find_on_page");
  assert.equal(intentOf("zoom in"), "zoom_in");
  assert.equal(intentOf("zoom out"), "zoom_out");
  assert.equal(intentOf("reset zoom"), "zoom_reset");
  assert.equal(intentOf("read this page"), "read_page");
  assert.equal(intentOf("repeat that"), "repeat_last");
  assert.equal(intentOf("again"), "repeat_last");
});

test("'go to tab N' resolves a tab number, 1-based as spoken", () => {
  assert.equal(recognize("go to tab 3").tab_index, 3);
  assert.equal(recognize("tab one").tab_index, 1);
  assert.equal(recognize("switch to tab seven").tab_index, 7);
  // A directional tab command carries no number.
  assert.equal(recognize("next tab").tab_index, undefined);
  assert.equal(recognize("next tab").tab_direction.choice, "next");
  assert.equal(recognize("previous tab").tab_direction.choice, "previous");
});

test("'yes', 'no' and 'confirm' are not hijacked by dialog answering", () => {
  // These already mean confirm/cancel. Answering a dialog must not steal them, because the rule
  // table cannot know whether a dialog is open.
  assert.equal(intentOf("confirm"), "confirm");
  assert.equal(intentOf("yes"), "confirm");
  assert.equal(intentOf("yep"), "confirm");
  assert.equal(intentOf("cancel"), "cancel");
  assert.equal(intentOf("no"), "cancel");
  assert.equal(intentOf("nope"), "cancel");
});

test("click flavours keep click_element so the model still resolves a target", () => {
  const howOf = (p) => {
    const r = recognize(p);
    return r?.intent?.choice === "click_element" ? r.how : r?.intent?.choice ?? null;
  };
  assert.equal(howOf("right click on the file"), "right");
  assert.equal(howOf("open the context menu on that"), "right");
  assert.equal(howOf("double click the icon"), "double");
  assert.equal(howOf("hover over the menu"), "hover");
  assert.equal(howOf("show the tooltip for the save button"), "hover");
  assert.equal(howOf("open docs in a new tab"), "new_tab");
  assert.equal(howOf("drag the file onto the bin"), "drag");
  assert.equal(howOf("drag it right"), "drag");
  // A plain click is untouched and carries no flavour.
  assert.equal(howOf("click the first link"), undefined);
  assert.equal(intentOf("click the first link"), "click_element");
  // The drop target and direction travel with the command.
  assert.equal(recognize("drag the file onto the recycle bin").drop_text, "the recycle bin");
  assert.equal(recognize("drag it right").drag_dir, "right");
  assert.equal(recognize("drag it down").drag_dir, "down");
});

test("horizontal and continuous scrolling are their own intents", () => {
  assert.equal(intentOf("scroll right"), "scroll_right");
  assert.equal(intentOf("scroll left"), "scroll_left");
  assert.equal(intentOf("go right"), "scroll_right");
  // "more" stays a single scroll; only an explicit keep-scrolling repeats.
  assert.equal(intentOf("more"), "scroll_down");
  assert.equal(intentOf("keep scrolling"), "scroll_start");
  assert.equal(intentOf("keep scrolling up"), "scroll_start");
  assert.equal(recognize("keep scrolling up").scroll_direction, "up");
  assert.equal(recognize("keep scrolling").scroll_direction, "down");
  assert.equal(intentOf("stop scrolling"), "scroll_stop");
  assert.equal(intentOf("that's enough"), "scroll_stop");
});

test("keyboard commands reach the browser as keys and chords", () => {
  const keyOf = (p) => {
    const r = recognize(p);
    return r?.intent?.choice === "press_key" ? r.press_key.key : r?.intent?.choice ?? null;
  };
  assert.equal(keyOf("tab"), "Tab");
  assert.equal(keyOf("escape"), "Escape");
  assert.equal(keyOf("dismiss that"), "Escape");
  assert.equal(keyOf("backspace"), "Backspace");
  assert.equal(keyOf("delete"), "Delete");
  assert.equal(keyOf("home"), "Home");
  assert.equal(keyOf("end"), "End");
  assert.equal(keyOf("down arrow"), "ArrowDown");
  assert.equal(keyOf("up arrow"), "ArrowUp");
  assert.equal(keyOf("select all"), "Control+a");
  assert.equal(keyOf("copy"), "Control+c");
  assert.equal(keyOf("paste"), "Control+v");
  assert.equal(keyOf("cut"), "Control+x");
  assert.equal(keyOf("control z"), "Control+z");
  assert.equal(keyOf("clear the box"), "clear_field");
  assert.equal(keyOf("clear that"), "clear_field");
  // Page-level undo/redo already belong to the history rules and must keep winning.
  assert.equal(keyOf("undo that"), "go_back");
  assert.equal(keyOf("redo that"), "go_forward");
  // Enter keeps working.
  assert.equal(keyOf("press enter"), "press_enter");
});

test("'show numbers' does not swallow real navigation or scrolling", () => {
  assert.equal(intentOf("show me google"), "navigate_url");
  assert.equal(intentOf("open youtube"), "navigate_url");
  assert.equal(intentOf("show more"), "scroll_down");
  assert.equal(intentOf("scroll to the bottom"), "scroll_down");
  assert.equal(intentOf("click the first link"), "click_element");
  assert.equal(intentOf("search for cats"), "search_web");
  assert.equal(intentOf("type hello in the search box"), "type_into_field");
});

test("search accepts every verb and optional site phrase", () => {
  const forms = [
    "search for cats",
    "search cats",
    "look up cats",
    "google cats",
    "find cats",
    "search youtube for cats",
    "search on the web for cats",
    "search duckduckgo for cats",
    "search wikipedia for cats",
  ];
  for (const t of forms) {
    const r = recognize(t);
    assert.ok(r, `"${t}" should be recognised`);
    assert.equal(r.intent.choice, "search_web", t);
    assert.equal(r.text_span.choice, "cats", `"${t}" should extract the query verbatim`);
  }
});

test("recognizes more scroll phrasings", () => {
  assert.equal(intentOf("page down"), "scroll_down");
  assert.equal(intentOf("scroll to the bottom"), "scroll_down");
  assert.equal(intentOf("keep going"), "scroll_down");
  assert.equal(intentOf("scroll to the top"), "scroll_up");
  assert.equal(intentOf("see more"), "scroll_down");
});

test("'open new tab' is a tab command, never a navigation", () => {
  const forms = ["open new tab", "open a new tab", "new tab", "open a new tab please", "open a new window"];
  for (const t of forms) {
    assert.equal(intentOf(t), "open_new_tab", `"${t}" must open a tab, not navigate`);
    assert.equal(siteOf(t), "none", t);
  }
});

test("'open <element>' is a click, not a navigation", () => {
  const cases = {
    "open the first link": 0,
    "open the second result": 1,
    "open the comments tab": undefined,
    "press the second link": 1,
  };
  for (const [t, ord] of Object.entries(cases)) {
    const r = recognize(t);
    assert.equal(r.intent.choice, "click_element", `"${t}" should click, not navigate`);
    assert.equal(r.ordinal, ord, t);
  }
});

test("every rule branch runs without throwing and returns a usable shape", () => {
  const samples = [
    "go back", "undo that", "previous page", "go forward", "redo that",
    "reload", "refresh the page", "open a new tab", "close this tab", "next tab",
    "previous tab", "switch tab", "press enter", "submit", "scroll down",
    "scroll down a bit", "keep going", "see more", "scroll to the bottom",
    "scroll up", "scroll to the top", "go home", "go to wikipedia",
    "go to example dot com", "open hacker news", "open claude", "open chatgpt",
    "search for alan turing", "search cats", "look up cats", "google cats",
    "find cats", "search youtube for lofi beats", "search on the web for cats",
    "search duckduckgo for news", "search github for react", "click the first result",
    "press the second link", "type hello world into the search box", "enter my email",
    "confirm", "go ahead", "cancel", "never mind", "okay please scroll down",
    "um go to youtube", "open netflix", "visit stack overflow",
  ];
  for (const t of samples) {
    const r = recognize(t);
    assert.ok(r, `"${t}" should be recognised`);
    assert.equal(r.intent.type, "choice", t);
    assert.ok(r.intent.confidence > 0, t);
    assert.equal(r.is_command.type, "noul", t);
    assert.equal(r.site.type, "choice", t);
    if (r.intent.choice === "navigate_url") {
      assert.ok(r.site.choice !== "none" || r.url_span, `"${t}" navigation needs a destination`);
    }
    if (r.intent.choice === "search_web") {
      assert.ok(r.text_span && r.text_span.choice, `"${t}" search needs a query`);
    }
  }
});