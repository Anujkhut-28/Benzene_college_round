/**
 * Browser management: launch a headed Playwright Chromium with a persistent profile
 * (so it feels like "your browser"), or attach to a running Chrome via --cdp ws://...
 * Tracks tabs and exposes the active page.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installOverlay } from "./overlay.js";
import { collectElementsInPage, buildSnapshot } from "./snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_DIR = path.join(__dirname, "..", ".browser-profile");

export class BrowserManager {
  constructor() {
    this.context = null;
    this.browser = null;
    this.active = null;
    this.pages = [];
    this.listeners = new Set();
    this.startUrl = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  async launch({ headless = false, cdp = null, profileDir = DEFAULT_PROFILE_DIR, startUrl = "about:blank" } = {}) {
    if (cdp) {
      this.browser = await chromium.connectOverCDP(cdp);
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    } else {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: headless ? { width: 1280, height: 900 } : null,
        args: headless ? [] : ["--window-size=1280,900", "--window-position=40,40"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
    await this.context.addInitScript(installOverlay);

    this.context.on("page", (page) => this._track(page));
    this.context.on("close", () => {
      this.pages = [];
      this.active = null;
      this._emit();
    });
    for (const p of this.context.pages()) this._track(p);
    if (this.pages.length === 0) await this.context.newPage();
    this.startUrl = startUrl;
    this.active = this.pages[this.pages.length - 1];
    if (startUrl && startUrl !== "about:blank") {
      await this.active.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    this._emit();
    return this;
  }

  _track(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    this.active = page;
    page.on("close", () => {
      this.pages = this.pages.filter((p) => p !== page);
      if (this.active === page) this.active = this.pages[this.pages.length - 1] || null;
      this._emit();
    });
    page.on("framenavigated", async (frame) => {
      if (frame === page.mainFrame()) {
        this._cachedVp = null;
        // The overlay (and the tracking cursor) lives in the document, so a navigation
        // destroys them. Wait for the new DOM, then put the cursor back where it was.
        setTimeout(() => this.repaintCursor().catch(() => {}), 350);
        this._emit();
      }
    });
    this._emit();
  }

  get page() {
    if (!this.active || this.active.isClosed()) this.active = this.pages.find((p) => !p.isClosed()) || null;
    return this.active;
  }

  async ensurePage() {
    if (!this.page) {
      await this.context.newPage();
    }
    return this.page;
  }

  isConnected() {
    if (!this.context) return false;
    try {
      if (this.context._closed) return false;
      return (this.context.pages() || []).length > 0;
    } catch {
      return false;
    }
  }

  hasPages() {
    return this.pages.some((p) => !p.isClosed());
  }

  async reopen() {
    if (!this.context) throw new Error("browser not launched");
    let page = this.context.pages().find((p) => !p.isClosed());
    if (!page) page = await this.context.newPage();
    this.active = page;
    await page.bringToFront().catch(() => {});
    this._emit();
    return page.url();
  }

  async setActive(page) {
    this.active = page;
    await page.bringToFront().catch(() => {});
    this._emit();
  }

  tabInfo() {
    return this.pages.map((p, i) => ({ index: i, url: p.url(), active: p === this.active }));
  }

  /** URL of the active page, or null (sync; used to record what an action led to). */
  currentUrl() {
    try {
      return this.active && !this.active.isClosed() ? this.active.url() : null;
    } catch {
      return null;
    }
  }

  /** Snapshot the active page (URL, title, compact element list, search box, site). */
  async snapshot() {
    const page = await this.ensurePage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
      const data = await page.evaluate(collectElementsInPage);
      return buildSnapshot(data, { tabs: this.tabInfo() });
    } catch (err) {
      // e.g. navigation in progress; return a minimal snapshot
      return buildSnapshot({ url: page.url(), title: "", scrollY: 0, scrollHeight: 0, viewportHeight: 0, elements: [] }, { tabs: this.tabInfo(), error: String(err.message || err) });
    }
  }

  async overlay(fn, ...args) {
    const page = this.page;
    if (!page || page.isClosed()) return;
    await page
      .evaluate(
        ([fn, args]) => {
          if (!window.__vb) return false;
          return window.__vb[fn](...args);
        },
        [fn, args],
      )
      .catch(async () => {
        await page.evaluate(installOverlay).catch(() => {});
      });
  }

  async getViewport() {
    const page = this.page;
    if (!page || page.isClosed()) return { width: 1280, height: 900 };
    const vp = page.viewportSize();
    if (vp && vp.width && vp.height) return vp;
    if (this._cachedVp) return this._cachedVp;
    try {
      const inner = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (inner && inner.width && inner.height) {
        this._cachedVp = inner;
        return inner;
      }
    } catch {}
    return { width: 1280, height: 900 };
  }

  async pointer(opts = {}) {
    this._nextPointer = opts;
    if (this._pointerBusy) return { ok: true };
    this._pointerBusy = true;
    try {
      while (this._nextPointer) {
        const next = this._nextPointer;
        this._nextPointer = null;
        await this._execPointer(next);
      }
    } finally {
      this._pointerBusy = false;
    }
    return { ok: true };
  }

  async _execPointer({ x, y, click = false } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return { ok: false };
    const vp = await this.getViewport();
    const px = Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * (vp.width - 1));
    const py = Math.round(Math.max(0, Math.min(1, Number(y) || 0)) * (vp.height - 1));
    this.lastPointer = { x, y, px, py };

    if (click) {
      await this.overlay("cursor", { x: px, y: py, visible: true, down: true }).catch(() => {});
      await page.mouse.click(px, py).catch(() => {});
    } else {
      await page.mouse.move(px, py).catch(() => {});
      await this.overlay("cursor", { x: px, y: py, visible: true, down: false }).catch(() => {});
    }
    return { ok: true, detail: `${px},${py}` };
  }

  async repaintCursor() {
    const s = this.lastPointer;
    if (!s) return;
    const page = this.page;
    if (!page || page.isClosed()) return;
    await this.overlay("cursor", { x: s.px, y: s.py, visible: true, down: false }).catch(() => {});
    await page.mouse.move(s.px, s.py).catch(() => {});
  }

  /**
   * Click an element by id, but refuse anything the policy would treat as destructive.
   * A pointer/pinch click must never be able to buy something or submit a form on its own.
   */
  async clickElement(id, { source = "pointer", destructiveGuard = true } = {}) {
    const page = await this.ensurePage();
    const loc = page.locator(`[data-vb-id="${id}"]`).first();
    const exists = await loc.count();
    if (!exists) return { ok: false, detail: "element not found" };

    if (destructiveGuard) {
      const risky = await loc.evaluate((el) => {
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.value || ""}`.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (["submit", "button"].includes(type) && /(buy|checkout|pay|order|place|send|post|delete|remove|confirm|subscribe|sign ?up|log ?in)/.test(text)) return true;
        return /(buy now|place order|checkout|submit|send message|delete|remove|confirm purchase)/.test(text);
      });
      if (risky) {
        await this.overlay("toast", 'Say "confirm" to activate this', 4000);
        return { ok: false, detail: "destructive action needs a spoken confirm" };
      }
    }

    await this.overlay("highlight", id, 500);
    await loc.click({ timeout: 4000 }).catch(() => loc.evaluate((el) => el.click()));
    return { ok: true, detail: page.url() };
  }

  async relaunch(opts = {}) {
    await this.close();
    this.pages = [];
    this.active = null;
    this.context = null;
    this.browser = null;
    await this.launch(opts);
    return this;
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
