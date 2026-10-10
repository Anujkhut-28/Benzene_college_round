/**
 * Execute a policy action on the controlled browser with Playwright.
 * Shows overlay feedback (highlight + toast) on the page.
 */
import { HIGHLIGHT_MS } from "./constants.js";
import { describe } from "./policy.js";

const NAV_TIMEOUT = 15000;

// What "show numbers" is willing to badge. Deliberately the same shape as the overlay's snap
// targets so a numbered badge and a snap target can never disagree about what is clickable.
const NUMBERABLE_SELECTOR =
  "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link]," +
  "[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=searchbox],[role=combobox]," +
  "[role=tab],[role=option],[role=textbox]";

function locatorFor(page, id) {
  return page.locator(`[data-vb-id="${id}"]`).first();
}

async function settle(page, ms = 2500) {
  await Promise.race([page.waitForLoadState("domcontentloaded").catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  await page.waitForTimeout(120);
}

/** Wait for a possible new tab after a click (target=_blank). */
async function maybeNewTab(browser, before) {
  await new Promise((r) => setTimeout(r, 400));
  const fresh = browser.pages.find((p) => !before.includes(p));
  if (fresh) await browser.setActive(fresh);
}

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {import('./browser.js').BrowserManager} browser
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
/**
 * Where a scroll should land. The tracked cursor wins, because the natural gesture is "look at
 * the chat pane and say scroll down". Falls back to a named element, then the middle of the
 * screen. Coordinates are viewport-relative, which is what mouse.move and wheel both want.
 */
async function resolveScrollPoint(page, browser, action) {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 900 };
    const cur = browser.pointerPos;
    if (cur && cur.x > 0 && cur.y > 0) return { x: cur.x, y: cur.y };
    if (action.targetId) {
      const box = await locatorFor(page, action.targetId).boundingBox().catch(() => null);
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
  } catch {
    return null;
  }
}

export async function execute(action, browser) {
  const page = await browser.ensurePage();
  const label = describe(action);

  switch (action.type) {
    case "show_numbers": {
      // Re-read the page here rather than trusting the snapshot the policy saw: the user asked
      // for this a moment ago and the DOM may have moved on since.
      const numbered = await page
        .evaluate((sel) => {
          const items = [];
          let n = 0;
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            const st = getComputedStyle(el);
            if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
            const text =
              `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ` +
              `${el.getAttribute("placeholder") || ""} ${el.value || ""} ${el.getAttribute("name") || ""}`
                .replace(/\s+/g, " ")
                .trim();
            let id = el.getAttribute("data-vb-id");
            if (!id) {
              window.__vbNextId = window.__vbNextId || 1;
              id = `vb${window.__vbNextId++}`;
              el.setAttribute("data-vb-id", id);
            }
            items.push({ n: ++n, id, label: text.slice(0, 60) || id, role: el.tagName.toLowerCase() });
            if (n >= 60) break; // 60 badges is already a wall of numbers
          }
          return items;
        }, NUMBERABLE_SELECTOR)
        .catch(() => []);
      return { ok: true, detail: `numbered ${numbered.length} items`, numbered };
    }

    case "hide_numbers": {
      await browser.overlay("clearCandidates");
      return { ok: true, detail: "numbers hidden" };
    }

    case "navigate_url": {
      await browser.overlay("toast", `→ ${label}`);
      const host = new URL(action.url).hostname.replace(/^www\./, "");
      try {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } catch (e) {
        // Transient network error or a site that never fires load: retry once, then accept if the
        // URL at least moved to the right host.
        await new Promise((r) => setTimeout(r, 500));
        await page.goto(action.url, { waitUntil: "commit", timeout: NAV_TIMEOUT }).catch(() => {});
        if (!page.url().includes(host)) throw e;
      }
      await settle(page, 800);
      return { ok: true, detail: page.url() };
    }

    case "click_element": {
      const before = [...browser.pages];
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await new Promise((r) => setTimeout(r, 180)); // let the human see the highlight
      const how = action.how || "click";

      // Hovering is not clicking: the pointer arrives, but no click event fires.
      if (how === "hover") {
        await loc.hover({ timeout: 4000 }).catch(() => {});
        return { ok: true, detail: "hovered" };
      }

      if (how === "drag") {
        // Drag needs somewhere to go: either a second named target, or a direction from here,
        // which is how you move a slider or a scrollbar thumb.
        const from = await loc.boundingBox().catch(() => null);
        if (!from) return { ok: false, detail: "cannot drag that" };
        const startX = from.x + from.width / 2;
        const startY = from.y + from.height / 2;
        let endX = startX + (action.dx ?? 140);
        let endY = startY + (action.dy ?? 0);
        // "drag X onto the trash": the drop target is matched by text in the page, since the
        // model answers one target per pass and cannot name a second one here.
        let dropId = action.dropId;
        if (!dropId && action.dropText) {
          dropId = await page
            .evaluate(({ sel, wanted }) => {
              const w = String(wanted).toLowerCase().replace(/\bthe\b|\bthat\b|\bthis\b/g, "").trim();
              if (!w) return null;
              const all = Array.from(document.querySelectorAll(sel));
              const hit =
                all.find((el) => (el.getAttribute("aria-label") || "").toLowerCase().includes(w)) ||
                all.find((el) => (el.textContent || "").toLowerCase().replace(/\s+/g, " ").includes(w));
              if (!hit) return null;
              let id = hit.getAttribute("data-vb-id");
              if (!id) {
                window.__vbNextId = window.__vbNextId || 1;
                id = `vb${window.__vbNextId++}`;
                hit.setAttribute("data-vb-id", id);
              }
              return id;
            }, { sel: NUMBERABLE_SELECTOR, wanted: action.dropText })
            .catch((err) => {
              // Not silently: a drag that quietly lands 140px away is worse than one that says why.
              console.warn(`drop target "${action.dropText}" not found: ${err.message || err}`);
              return null;
            });
        }
        if (dropId) {
          const to = await locatorFor(page, dropId).boundingBox().catch(() => null);
          if (to) {
            endX = to.x + to.width / 2;
            endY = to.y + to.height / 2;
          } else {
            console.warn(`drop target ${dropId} has no box on screen`);
          }
        }
        // "drag X right" has no target, only a direction.
        const D = { right: [140, 0], left: [-140, 0], up: [0, -100], down: [0, 100] };
        if (action.dragDir && D[action.dragDir]) {
          endX = startX + D[action.dragDir][0];
          endY = startY + D[action.dragDir][1];
        }
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        // Intermediate moves: most drag handlers never see a drag without them.
        for (let i = 1; i <= 8; i++) {
          await page.mouse.move(startX + ((endX - startX) * i) / 8, startY + ((endY - startY) * i) / 8);
        }
        await page.mouse.up();
        return { ok: true, detail: `dragged ${Math.round(endX - startX)},${Math.round(endY - startY)}` };
      }

      const opts = { timeout: 4000 };
      if (how === "right") opts.button = "right";
      if (how === "double") opts.clickCount = 2;
      if (how === "new_tab") opts.button = "middle";
      if (how === "new_tab_ctrl") opts.modifiers = ["Control"];

      try {
        await loc.click(opts);
      } catch {
        // A synthetic DOM click cannot express right/double/middle/modifier, so only the plain
        // path is faked. Failing loudly beats silently doing the wrong thing to the page.
        if (how === "click") await loc.evaluate((el) => el.click());
        else throw new Error(`${how} on that element failed`);
      }
      await settle(page);
      await maybeNewTab(browser, before);
      const extra = browser.pages.length - before.length;
      return { ok: true, detail: browser.page.url() + (extra > 0 ? ` (+${extra} tab)` : "") };
    }

    case "type_into_field": {
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await loc.click({ timeout: 4000 }).catch(() => loc.focus());
      // `append` is dictation: keep what is already in the box and add to it. Everything else
      // replaces the contents, which is what "type X into the search box" has always meant.
      if (!action.append) await loc.fill("").catch(() => {});
      if (action.text) {
        await loc.pressSequentially(action.text, { delay: 18 }).catch(async () => loc.fill(action.text));
      }
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return { ok: true, detail: page.url() };
    }

    case "press_key": {
      await browser.overlay("toast", label);
      // Escape/Tab/arrows move focus and often change the page; the rest do not need to settle.
      const navigating = ["Enter", "Tab", "Escape"].includes(action.key);
      // "Control+a" etc. reach the browser as real chords, which is what clipboard actions need.
      const parts = String(action.key).split("+");
      const chord = parts.length > 1;
      if (chord) {
        for (let i = 0; i < parts.length - 1; i++) await page.keyboard.down(parts[i]);
        await page.keyboard.press(parts[parts.length - 1]);
        for (let i = parts.length - 2; i >= 0; i--) await page.keyboard.up(parts[i]);
      } else {
        await page.keyboard.press(action.key);
      }
      if (navigating) await settle(page);
      return { ok: true, detail: page.url() };
    }

    // Dictation: type wherever the caret already is, with no target to name. This is what makes
    // filling in a long form bearable - you say the words instead of "type ... into the box".
    case "type_into_focus": {
      await browser.overlay("toast", label);
      const typed = await page.keyboard.type(action.text, { delay: 18 }).then(() => true).catch(() => false);
      if (!typed) return { ok: false, detail: "no focused field" };
      return { ok: true, detail: `typed into the focused field` };
    }

    case "select_option": {
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      // Match option by (case-insensitive, substring) label in code.
      const picked = await loc.evaluate((sel, wanted) => {
        const w = wanted.toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === w) || opts.find((o) => o.label.toLowerCase().includes(w));
        if (!hit) return null;
        sel.value = hit.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return hit.label;
      }, action.text);
      return { ok: Boolean(picked), detail: picked || "no matching option" };
    }

    case "press_enter":
      await browser.overlay("toast", "⏎ enter");
      await page.keyboard.press("Enter");
      await settle(page);
      return { ok: true, detail: page.url() };

    case "stop_scrolling":
      return { ok: true, detail: "stopped" };

    case "start_scrolling":
      // The controller owns the repeat loop; nothing to do here but say so.
      return { ok: true, detail: `scrolling ${action.direction || "down"}` };

    case "scroll_down":
    case "scroll_up":
    case "scroll_left":
    case "scroll_right": {
      await browser.overlay("toast", label);
      const vertical = action.type !== "scroll_left" && action.type !== "scroll_right";
      const dir = action.type === "scroll_down" || action.type === "scroll_right" ? 1 : -1;
      const amount = action.amount || "page";

      // Where to scroll: the tracked cursor if there is one, else a named element, else centre.
      // This is what makes chat panes, modals and feeds scroll - the wheel goes wherever the
      // user is looking, and whatever is under the point takes it, not the whole window.
      const point = await resolveScrollPoint(page, browser, action);
      if (point) await page.mouse.move(point.x, point.y);

      if (amount === "end") {
        const moved = await page.evaluate(
          ([x, y, vertical, dir]) => {
            // Walk up from the point to the nearest thing that can actually scroll this way.
            let el = document.elementFromPoint(x, y);
            while (el) {
              const canV = el.scrollHeight > el.clientHeight + 4;
              const canH = el.scrollWidth > el.clientWidth + 4;
              if (vertical ? canV : canH) break;
              el = el.parentElement;
            }
            const target = el && (vertical ? el.scrollHeight > el.clientHeight + 4 : el.scrollWidth > el.clientWidth + 4) ? el : document.scrollingElement || document.documentElement;
            if (vertical) target.scrollTo({ top: dir > 0 ? target.scrollHeight : 0, behavior: "smooth" });
            else target.scrollTo({ left: dir > 0 ? target.scrollWidth : 0, behavior: "smooth" });
            return target === document.scrollingElement || target === document.documentElement ? "page" : (target.className || target.tagName).toString().slice(0, 30);
          },
          [point?.x ?? 0, point?.y ?? 0, vertical, dir],
        );
        await page.waitForTimeout(400);
        return { ok: true, detail: `${amount} of ${moved || "page"}` };
      }

      const step = amount === "little" ? 0.35 : 0.85;
      const size = page.viewportSize() || { width: 1280, height: 900 };
      const dx = vertical ? 0 : Math.round(dir * size.width * step);
      const dy = vertical ? Math.round(dir * size.height * step) : 0;
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(320);
      const where = await page.evaluate(
        ([x, y, vertical]) => {
          const el = document.elementFromPoint(x, y);
          return vertical ? `scrollY=${Math.round(window.scrollY)}` : `scrollX=${Math.round(window.scrollX)}`;
        },
        [point?.x ?? 0, point?.y ?? 0, vertical],
      );
      return { ok: true, detail: where };
    }

    case "go_back":
      await browser.overlay("toast", "← back");
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "go_forward":
      await browser.overlay("toast", "→ forward");
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "reload":
      await browser.overlay("toast", "↻ reload");
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      return { ok: true, detail: page.url() };

    case "open_new_tab": {
      const p = await browser.context.newPage();
      await browser.setActive(p);
      const target = action.url || browser.startUrl || "about:blank";
      if (target && target !== "about:blank") {
        await p.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
        await settle(p, 800);
      }
      await browser.overlay("toast", "new tab");
      return { ok: true, detail: p.url() };
    }

    case "close_tab": {
      await page.close();
      if (browser.pages.length === 0) await browser.context.newPage();
      await browser.setActive(browser.page);
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "switch_tab": {
      const pages = browser.pages;
      if (Number.isInteger(action.index)) {
        // "go to tab 3" - tabs are spoken 1-based, stored 0-based.
        const target = pages[action.index];
        if (!target || target.isClosed()) return { ok: false, detail: `there is no tab ${action.index + 1}` };
        await browser.setActive(target);
        await browser.overlay("toast", `tab ${action.index + 1}`);
        return { ok: true, detail: target.url() };
      }
      if (pages.length < 2) return { ok: false, detail: "only one tab" };
      const i = pages.indexOf(browser.page);
      let next;
      if (action.direction === "previous") next = pages[(i - 1 + pages.length) % pages.length];
      else if (action.direction === "first") next = pages[0];
      else if (action.direction === "last") next = pages[pages.length - 1];
      else next = pages[(i + 1) % pages.length];
      await browser.setActive(next);
      await browser.overlay("toast", "switched tab");
      return { ok: true, detail: next.url() };
    }

    case "reopen_tab": {
      // Browsers keep recently closed tabs; Ctrl+Shift+T is the way back to them and needs no
      // session history of our own.
      const before = browser.pages.length;
      await page.keyboard.press("Control+Shift+T");
      await new Promise((r) => setTimeout(r, 700));
      await browser.overlay("toast", "reopened tab");
      return { ok: true, detail: browser.pages.length > before ? browser.page.url() : "no tab to reopen" };
    }

    case "close_other_tabs": {
      const keep = browser.page;
      const others = browser.pages.filter((p) => p !== keep && !p.isClosed());
      for (const p of others) await p.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      await browser.setActive(browser.page || keep);
      await browser.overlay("toast", `closed ${others.length} tab${others.length === 1 ? "" : "s"}`);
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "read_page": {
      // Read what a sighted user would read: the main content, with menus and boilerplate out.
      const text = await page.evaluate(() => {
        const pick =
          document.querySelector("article, main, [role=main]") ||
          document.body;
        if (!pick) return "";
        const clone = pick.cloneNode(true);
        clone.querySelectorAll("script,style,nav,header,footer,aside,noscript,svg").forEach((n) => n.remove());
        return (clone.innerText || "").replace(/\s+/g, " ").trim();
      }).catch(() => "");
      if (!text) return { ok: false, detail: "nothing readable on this page" };
      return { ok: true, detail: `${text.length} chars`, speak: text.slice(0, 900) };
    }

    case "answer_prompt": {
      const dlg = browser.pendingDialog;
      if (!dlg) return { ok: false, detail: "nothing is asking" };
      if (action.accept) await dlg.accept().catch(() => {});
      else await dlg.dismiss().catch(() => {});
      browser.pendingDialog = null;
      return { ok: true, detail: action.accept ? "accepted" : "dismissed" };
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}
