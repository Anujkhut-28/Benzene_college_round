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
      try {
        await loc.click({ timeout: 4000 });
      } catch {
        await loc.evaluate((el) => el.click());
      }
      await settle(page);
      await maybeNewTab(browser, before);
      return { ok: true, detail: browser.page.url() };
    }

    case "type_into_field": {
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await loc.click({ timeout: 4000 }).catch(() => loc.focus());
      await loc.fill("").catch(() => {});
      await loc.pressSequentially(action.text, { delay: 18 }).catch(async () => loc.fill(action.text));
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return { ok: true, detail: page.url() };
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

    case "scroll_down":
    case "scroll_up": {
      const dir = action.type === "scroll_down" ? 1 : -1;
      await browser.overlay("toast", label);
      await page.evaluate(
        ([dir, amount]) => {
          const vh = window.innerHeight;
          if (amount === "end") {
            window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
          } else {
            const px = amount === "little" ? vh * 0.35 : vh * 0.85;
            window.scrollBy({ top: dir * px, behavior: "smooth" });
          }
        },
        [dir, action.amount || "page"],
      );
      await page.waitForTimeout(350);
      return { ok: true, detail: `scrollY=${await page.evaluate(() => Math.round(window.scrollY))}` };
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
      if (pages.length < 2) return { ok: false, detail: "only one tab" };
      const i = pages.indexOf(browser.page);
      let next;
      if (action.direction === "previous") next = pages[(i - 1 + pages.length) % pages.length];
      else if (action.direction === "first") next = pages[0];
      else next = pages[(i + 1) % pages.length];
      await browser.setActive(next);
      await browser.overlay("toast", "switched tab");
      return { ok: true, detail: next.url() };
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}
