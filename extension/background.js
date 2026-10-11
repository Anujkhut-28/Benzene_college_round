/**
 * HandsFree MV3 service worker.
 *
 * Owns the single WebSocket to the local HandsFree server. Keeps it alive across
 * worker restarts, reconnects with backoff, and fans messages out to the popup
 * and to the content script in the active tab.
 *
 * The service worker is event-driven and gets killed aggressively, so all
 * mutable connection state is kept in chrome.storage.session and restored here
 * on every wake-up rather than held in a module-level variable.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

/** Reconnect backoff in ms. Indexed by attempt count, capped at the last entry. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
/** Messages that arrived before a client attached, so the popup is never blank on open. */
const pending = [];

const state = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  connected: false,
  listening: false,
  tracking: false,
  trackerStatus: null,
  lastError: null,
  model: null,
};

/**
 * What the user last asked for. The worker is evicted constantly and `listening` may be
 * announced asynchronously by the speech host, so a late `offscreenReady` arriving after
 * a Stop would otherwise flip the feature back on with no recogniser behind it.
 */
let wantListening = false;

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

function broadcast(message) {
  // Tracker status is high frequency (every camera frame) and only the popup needs it.
  // Forwarding it to the tab as well would be pure waste, so it takes its own path.
  const toTab = message?.type !== "tracker-status";
  chrome.runtime.sendMessage(message).catch(() => {});
  if (!toTab) return;
  // Must use findTargetTab, not chrome.tabs.query({active:true}): while the popup
  // has focus that returns the popup's own tab, so "tracking" never reached the page
  // and the camera was never asked for.
  findTargetTab()
    .then((tab) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    })
    .catch(() => {});
}

/**
 * The tab the user is actually looking at.
 *
 * `chrome.tabs.query({active: true})` is not enough: while a popup or a
 * devtools window has focus it can return a tab that is not the one on screen,
 * so actions were being delivered to the wrong page. Prefer the most recently
 * accessed normal tab, and ignore anything that is not a real web page.
 */
function findTargetTab() {
  return chrome.tabs
    .query({})
    .then((tabs) => {
      const usable = tabs.filter(
        (t) =>
          t.status !== "unloaded" &&
          /^(https?|file):/i.test(t.url || ""),
      );
      if (!usable.length) return null;
      const active = usable.find((t) => t.active);
      if (active) return active;
      // Fall back to the most recently used web page, which is almost always the
      // intent. Extension pages (the popup) must be excluded: they are not the
      // page the user is trying to control.
      return usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    })
    .catch(() => null);
}

/** Serial token so a slow delivery cannot overwrite a newer user's intent. */
let deliveryEpoch = 0;

/**
 * Send to the page and return its response, injecting the content script on demand.
 * A tab that was already open when the extension was installed never received the
 * content script, so it is injected rather than making the user reload manually.
 */
async function sendToPage(tabId, message) {
  try {
    return { ok: true, response: await chrome.tabs.sendMessage(tabId, message) };
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["head-tracker-core.js", "page-bridge.js", "content.js"],
      });
      return { ok: true, response: await chrome.tabs.sendMessage(tabId, message) };
    } catch {
      // Genuinely unreachable: a chrome:// page, the web store, or no tab at all.
      return { ok: false };
    }
  }
}

/**
 * Send to the page, reporting whether anything was actually listening.
 */
async function deliverToPage(message) {
  const epoch = ++deliveryEpoch;
  const tab = await findTargetTab();
  if (!tab?.id) return false;
  const res = await sendToPage(tab.id, message);
  return res.ok && epoch === deliveryEpoch;
}

/**
 * The server's executor drives a Playwright window the user cannot see. When the
 * extension is present, the same decisions are also carried out in the user's real
 * tab, so `broadcast` alone is not enough for actions and pending confirmations.
 */
function toActiveTab(message) {
  deliverToPage(message).catch(() => {});
}

async function publishStatus() {
  const status = {
    ...state,
    connected: socket?.readyState === WebSocket.OPEN,
    url: `ws://${state.host}:${state.port}`,
    buffered: pending.length,
  };
  state.connected = status.connected;
  await chrome.storage.session.set({ handsfree: status }).catch(() => {});
  broadcast({ type: "status", payload: status });
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function loadConfig() {
  const saved = await chrome.storage.local.get(["host", "port"]);
  state.host = saved.host || DEFAULT_HOST;
  state.port = Number(saved.port) || DEFAULT_PORT;
}

/**
 * Restore the state the previous instance of this worker owned.
 *
 * The worker is torn down after ~30s idle, but the WebSocket in it dies with it and the
 * offscreen document keeps the camera and the recogniser alive. Without this the popup
 * comes back to a worker that believes everything is off, so "Stop tracking" would do
 * nothing and the next Enable would start a second camera.
 */
async function restoreSession() {
  try {
    const saved = (await chrome.storage.session.get(["handsfree"]))?.handsfree;
    if (!saved) return;
    if (typeof saved.listening === "boolean") {
      state.listening = saved.listening;
      wantListening = saved.listening;
    }
    if (typeof saved.tracking === "boolean") state.tracking = saved.tracking;
    if (saved.trackerStatus) state.trackerStatus = saved.trackerStatus;
  } catch {
    // A brand new profile has no session storage; that is not an error.
  }
}

function clearReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => connect(), delay);
}

export async function connect({ reset = true } = {}) {
  clearReconnect();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reset) reconnectAttempt = 0;

  const url = `ws://${state.host}:${state.port}`;
  state.lastError = null;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    state.lastError = String(err?.message || err);
    await publishStatus();
    scheduleReconnect();
    return;
  }

  socket.onopen = async () => {
    reconnectAttempt = 0;
    state.lastError = null;
    await publishStatus();
    // Ask the server for a full state snapshot so a freshly-opened popup is current.
    send({ type: "state" });
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (pending.length < 200) pending.push(msg);
    // `broadcast` skips these on purpose (per-frame volume), so the tab needs them
    // delivered explicitly for the page to act on a spoken command.
    if (msg.type === "action" || msg.type === "pending") toActiveTab(msg);
    else broadcast(msg);
  };

  socket.onerror = () => {
    state.lastError = `cannot reach ${url}`;
  };

  socket.onclose = async () => {
    socket = null;
    await publishStatus();
    scheduleReconnect();
  };
}

export function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Voice capture
//
// The Web Speech API needs a document with a microphone grant and is not
// available to a service worker, so recognition runs in an offscreen document.
// ---------------------------------------------------------------------------

let offscreenReady = false;
/**
 * Chrome rejects a second `createDocument` with "Only a single offscreen document may be
 * created". Pressing Enable tracking and Start listening together, or a slider change
 * racing a start, both arrive here at once, so creation is serialised through one promise.
 */
let offscreenPromise = null;

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    // chrome.offscreen and chrome.runtime.getContexts landed together in Chrome 116.
    // Always re-check the real context rather than trusting the cached flag: this flag
    // resets every time the service worker is recycled, and a stale `true` would skip
    // creation and leave every later message undeliverable.
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) {
      offscreenReady = true;
      return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification:
          "HandsFree captures speech with the Web Speech API and runs the webcam face/hand landmark models, both of which are unavailable to a content script.",
      });
      offscreenReady = true;
    } catch (err) {
      // Another caller may have won the race between the context check and the create.
      const contexts = await chrome.runtime
        .getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
        .catch(() => []);
      if (!contexts?.length) throw err;
      offscreenReady = true;
    }
  })().finally(() => {
    offscreenPromise = null;
  });
  return offscreenPromise;
}

async function setListening(listening) {
  wantListening = Boolean(listening);
  if (listening) {
    await ensureOffscreen();
    // Wait for the host to actually be listening before announcing it, otherwise the
    // recogniser never starts and the popup still reads "off". The host reports the real
    // outcome, so a denied microphone or an unsupported browser surfaces here.
    const res = await sendToOffscreen("offscreenStart");
    // The user may have pressed Stop while the permission prompt was open; in that case
    // the late failure must not switch listening back on.
    if (!wantListening) return { ok: true };
    if (!res || res.ok === false) {
      // No answer at all means the host is unreachable; reporting success there would
      // show "listening" with nothing behind it.
      wantListening = false;
      state.listening = false;
      const error =
        res?.error || "the microphone host did not respond. Reload the extension and try again.";
      state.lastError = error;
      await publishStatus();
      return { ok: false, error };
    }
    state.listening = true;
  } else {
    state.listening = false;
    await sendToOffscreen("offscreenStop");
  }
  await publishStatus();
  return { ok: true };
}

/** Send to the offscreen host, retrying briefly while a fresh document boots. */
async function sendToOffscreen(type, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const res = await chrome.runtime
      .sendMessage({ type })
      .catch(() => null);
    if (res) return res;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

async function shutdown() {
  clearReconnect();
  reconnectAttempt = 0;
  if (socket) {
    const s = socket;
    socket = null;
    s.onclose = null;
    s.close();
  }
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    for (const ctx of contexts) await chrome.offscreen.closeDocument({ contextId: ctx.contextId });
  } catch {
    // No offscreen document is fine; nothing to tear down.
  }
  offscreenReady = false;
  offscreenPromise = null;
  // Closing the host releases the camera and the recogniser, so the worker must stop
  // claiming they are running.
  wantListening = false;
  state.listening = false;
  state.tracking = false;
  state.connected = false;
  state.trackerStatus = null;
  broadcast({ type: "tracking", payload: { tracking: false } });
  await publishStatus();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const handlers = {
  async status() {
    await loadConfig();
    await publishStatus();
    return { ...state, connected: socket?.readyState === WebSocket.OPEN, url: `ws://${state.host}:${state.port}` };
  },

  async connect({ host, port }) {
    await shutdown();
    await chrome.storage.local.set({
      ...(host ? { host } : {}),
      ...(port ? { port: Number(port) } : {}),
    });
    await loadConfig();
    await connect();
    return { host: state.host, port: state.port };
  },

  async disconnect() {
    await shutdown();
    return { ok: true };
  },

  async command({ text }) {
    if (!text) return { ok: false, error: "empty command" };
    return { ok: send({ type: "command", text }) };
  },

  async transcript({ text, final, utteranceId }) {
    return { ok: send({ type: "transcript", text, final: Boolean(final), utteranceId }) };
  },

  async pointer({ x, y, snap, click }) {
    return { ok: send({ type: "pointer", x, y, snap: Boolean(snap), click: Boolean(click) }) };
  },

  async undo() {
    return { ok: send({ type: "undo" }) };
  },

  async refreshSnapshot() {
    return { ok: send({ type: "snapshot" }) };
  },

  async setListening({ listening }) {
    try {
      const res = await setListening(Boolean(listening));
      if (res && res.ok === false) return res;
      return { ok: true };
    } catch (err) {
      state.listening = false;
      wantListening = false;
      const error = `microphone unavailable: ${err?.message || err}`;
      state.lastError = error;
      await publishStatus();
      return { ok: false, error };
    }
  },

  /** Live tracking settings, applied to an already-running tracker without restarting it. */
  async configure(patch = {}) {
    await chrome.storage.local.set(
      Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    );
    // The content script owns the tracker instance; hand it the new config.
    broadcast({ type: "configure", payload: patch });
    return { ok: true };
  },

  /** A content script needs the offscreen document; only the worker may create one. */
  async visionHost() {
    try {
      await ensureOffscreen();
      return { ok: true };
    } catch (err) {
      const error = `camera host unavailable: ${err?.message || err}`;
      state.lastError = error;
      await publishStatus();
      return { ok: false, error };
    }
  },

  /** Non-fatal notice from the vision host, e.g. the hand model failed to load. */
  async offscreenStatus({ message } = {}) {
    state.lastError = message ?? null;
    await publishStatus();
    return { ok: true };
  },

  /** The page reports live tracker state (calibrating, no face, pinching). */
  async trackerStatus(payload = {}) {
    state.trackerStatus = payload;
    if (payload.state === "error") state.lastError = payload.message ?? state.lastError;
    if (payload.state === "stopped") state.tracking = false;
    // Do not persist per-frame status to storage; only tell listeners now.
    chrome.runtime.sendMessage({ type: "status", payload: { ...state, connected: socket?.readyState === WebSocket.OPEN } }).catch(() => {});
    return { ok: true };
  },

  /** The page could not start tracking; put the reason where the popup can show it. */
  async trackerError({ message } = {}) {
    state.trackerStatus = { state: "error", message: message ?? "tracking failed" };
    state.lastError = message ?? state.lastError;
    // Tracking is not running, so it must not read as active in the popup.
    state.tracking = false;
    await publishStatus();
    return { ok: true };
  },

  /**
   * A page finished loading and is ready for instructions. It has no tracker of its own,
   * so re-assert the worker's state rather than leaving a stale "on" in the popup.
   */
  async contentReady(_payload = {}, sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") return { ok: true, tracking: Boolean(state.tracking) };
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "tracking",
        payload: { tracking: Boolean(state.tracking) },
      });
    } catch {
      // The page is mid-navigation; the next load sends contentReady again.
    }
    return { ok: true, tracking: Boolean(state.tracking) };
  },

  async setTracking({ tracking }) {
    const want = Boolean(tracking);
    state.tracking = want;
    state.trackerStatus = null;
    // Tracking needs the offscreen document for the camera and the landmark models.
    if (want) {
      try {
        await ensureOffscreen();
      } catch (err) {
        state.tracking = false;
        state.lastError = `camera unavailable: ${err?.message || err}`;
        await publishStatus();
        return { ok: false, error: state.lastError };
      }
    }
    // Tracking runs in the page, so tell the content script to start or stop it. The
    // page answers with the real outcome, so a denied camera is reported as a failure
    // instead of the popup briefly claiming the feature is on.
    const epoch = ++deliveryEpoch;
    const tab = await findTargetTab();
    if (!tab?.id) {
      state.tracking = false;
      state.lastError = "Open a normal web page first — there is nothing to control.";
      await publishStatus();
      return { ok: false, error: state.lastError };
    }
    const delivered = await sendToPage(tab.id, {
      type: "tracking",
      payload: { tracking: state.tracking },
    });
    if (!delivered.ok) {
      state.tracking = false;
      state.lastError = "This page cannot be controlled. Reload it, or use a normal web page (not chrome://).";
      await publishStatus();
      return { ok: false, error: state.lastError };
    }
    if (want && epoch === deliveryEpoch && delivered.response?.ok === false) {
      state.tracking = false;
      state.lastError = delivered.response.error ?? "tracking could not be started";
      await publishStatus();
      return { ok: false, error: state.lastError };
    }
    if (!want) {
      // Belt and braces: the host must let go of the camera even if the page never
      // received the stop (a closed tab, a tab that just navigated).
      sendToOffscreen("visionStop").catch(() => {});
      state.lastError = null;
    }
    await publishStatus();
    return { ok: true };
  },

  async recenter() {
    broadcast({ type: "recenter" });
    return { ok: true };
  },

  /** Recognition produced a transcript: push it straight down the socket. */
  async offscreenTranscript({ text, final, utteranceId }) {
    if (!text) return { ok: false };
    return { ok: send({ type: "transcript", text, final: Boolean(final), utteranceId }) };
  },

  async offscreenReady() {
    offscreenReady = true;
    // Only report listening if the user actually asked for it: a recognition session
    // that restarts on its own can announce itself after the user pressed Stop.
    if (wantListening) state.listening = true;
    await publishStatus();
    return { ok: true };
  },

  async offscreenError({ error }) {
    state.listening = false;
    wantListening = false;
    state.lastError = error || null;
    await publishStatus();
    return { ok: true };
  },

  async offscreenClosed() {
    offscreenReady = false;
    state.listening = false;
    // The host is gone, so the camera it held is gone too: never leave "on" showing.
    if (state.tracking) {
      state.tracking = false;
      state.trackerStatus = { state: "error", message: "the camera host closed" };
      state.lastError = "the camera host closed; press Enable tracking to restart";
    }
    await publishStatus();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg.payload ?? {}, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await publishStatus();
  await connect();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  await restoreSession();
  await connect();
});

// The worker is torn down and revived constantly; reconnect on every start so the
// popup and the offscreen document never find a dead socket.
chrome.runtime.onSuspend.addListener(() => clearReconnect());

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "start-listening") {
      await setListening(!state.listening);
    } else if (command === "recenter") {
      await deliverToPage({ type: "recenter" });
      broadcast({ type: "command", payload: { name: "recenter" } });
    }
  } catch {
    // A keyboard shortcut must never surface as an unhandled worker error.
  }
});

chrome.tabs.onRemoved.addListener(() => {
  broadcast({ type: "tab-changed" });
});

/**
 * A navigation destroys the content script, and with it the tracker, while the camera
 * keeps running in the offscreen host. Flip tracking off so the popup tells the truth;
 * the new page sends `contentReady`, and enabling it again is one click.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !state.tracking) return;
  state.tracking = false;
  state.trackerStatus = null;
  publishStatus().catch(() => {});
});

// If the service worker starts with no connection (e.g. after a browser restart
// without an onStartup event), top up the connection here too.
(async () => {
  await loadConfig();
  await restoreSession();
  await publishStatus();
  if (!socket) await connect();
})();