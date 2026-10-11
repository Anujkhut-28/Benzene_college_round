/**
 * Popup UI. Deliberately thin: the service worker owns the socket and all state.
 * The popup reads status and sends intents, and never talks to the server directly.
 */

const $ = (id) => document.getElementById(id);

const el = {
  model: $("model"),
  dot: $("dot"),
  host: $("host"),
  adv: $("adv"),
  port: $("port"),
  connect: $("connect"),
  status: $("status"),
  connError: $("connError"),
  track: $("track"),
  trackState: $("trkState"),
  recenter: $("recenter"),
  trkHint: $("trkHint"),
  mode: $("mode"),
  clickMode: $("clickMode"),
  sens: $("sens"),
  sensOut: $("sensOut"),
  eyeSens: $("eyeSens"),
  eyeSensOut: $("eyeSensOut"),
  mirror: $("mirror"),
  snap: $("snap"),
  listen: $("listen"),
  micState: $("micState"),
  cmdForm: $("cmdForm"),
  cmd: $("cmd"),
  log: $("log"),
  logSummary: $("logSummary"),
};

/**
 * Ask the service worker to do something.
 *
 * `chrome.runtime.sendMessage` rejects outright if the worker is not reachable, and an
 * unhandled rejection in a click handler is exactly the "button did nothing" failure.
 * Every caller therefore gets a result object it can render.
 */
const ask = async (type, payload = {}) => {
  try {
    return await chrome.runtime.sendMessage({ type, payload });
  } catch (err) {
    return { ok: false, error: `the extension worker did not respond: ${String(err?.message || err)}` };
  }
};

/** Serialise an action so rapid double-clicks cannot start two camera starts. */
const busy = new WeakSet();
async function once(el, fn) {
  if (busy.has(el)) return;
  busy.add(el);
  el.classList.add("busy");
  try {
    await fn();
  } finally {
    el.classList.remove("busy");
    busy.delete(el);
  }
}

function setStatus(text, tone = "") {
  el.status.textContent = text;
  el.status.className = `status ${tone}`.trim();
  el.dot.className = `dot-inline ${tone}`.trim();
}

function setError(text) {
  el.connError.textContent = text || "";
  el.connError.hidden = !text;
}

function setPill(node, text, tone = "") {
  node.textContent = text;
  node.className = `pill ${tone}`.trim();
}

const MODE_LABEL = { head: "Head", blend: "Gaze + head", eye: "Gaze" };

function renderStatus(s) {
  if (!s) return;
  // Never fight the user for an input they are actively editing.
  if (document.activeElement !== el.host) el.host.value = s.host ?? "";
  if (document.activeElement !== el.port) el.port.value = s.port ?? "";
  el.model.textContent = s.model || (s.connected ? "connected" : "not connected");

  const connected = Boolean(s.connected);
  // The Connect button lives inside the collapsed "Connection settings" panel, so only
  // reveal it when the user actually needs it (i.e. when we are not connected).
  if (el.connect) el.connect.textContent = connected ? "Reconnect" : "Connect";
  el.listen.disabled = !connected;
  el.track.disabled = !connected;

  // Tracking
  const tracking = Boolean(s.tracking);
  el.track.textContent = tracking ? "Stop tracking" : "Enable tracking";
  el.track.setAttribute("aria-pressed", String(tracking));
  el.track.classList.toggle("primary", !tracking);
  el.recenter.disabled = !tracking;

  const trk = s.trackerStatus || {};
  if (!tracking) {
    setPill(el.trackState, "off");
    setTrackHint(null);
  } else if (trk.state === "error") {
    setPill(el.trackState, "error", "err");
    setTrackHint(trk.message || "Tracking error", "err");
  } else if (trk.state === "starting" || (!trk.state && !trk.face && !trk.calibrating)) {
    setPill(el.trackState, "starting", "warn");
    setTrackHint(trk.message || "Allow the camera, then look straight ahead", "warn");
  } else if (trk.calibrating) {
    setPill(el.trackState, "calibrating", "warn");
    setTrackHint("Look straight ahead while it calibrates", "warn");
  } else if (trk.face === false) {
    setPill(el.trackState, "no face", "warn");
    setTrackHint("Can't see you — move back into frame", "warn");
  } else if (trk.pinching) {
    setPill(el.trackState, "pinch", "on");
    setTrackHint("Pinch registered — click sent", "ok");
  } else {
    setPill(el.trackState, MODE_LABEL[trk.mode] || "tracking", "on");
    setTrackHint(
      trk.clickMode === "none" ? "Tracking only — pinch-to-click is off" : null,
      "ok",
    );
  }

  // Voice
  el.listen.textContent = s.listening ? "Stop listening" : "Start listening";
  el.listen.setAttribute("aria-pressed", String(Boolean(s.listening)));
  el.listen.classList.toggle("primary", !s.listening);
  setPill(el.micState, s.listening ? "listening" : "off", s.listening ? "on" : "");

  // Connection state owns the status line. Tracking detail lives in its own line, so a
  // dropped connection can never be masked by a healthy tracking status.
  if (!connected) {
    const where = s.url || "the HandsFree server";
    setStatus(s.lastError ? s.lastError : `Not connected to ${where}`, "err");
    setError(s.lastError || "Start the server with `npm start`, then press Connect.");
    // Auto-open the settings so the Connect button is reachable without hunting.
    if (el.adv) el.adv.open = true;
  } else if (s.listening) {
    setStatus("Listening — speak a command", "ok");
    setError("");
  } else {
    setStatus(tracking ? "Connected · pointer control on" : "Connected", "ok");
    setError("");
  }
}

/** Tracking feedback goes under the tracking controls, not into the connection status. */
function setTrackHint(text, tone = "") {
  el.trkHint.textContent = text ?? "Uses your camera. Nothing leaves this machine.";
  el.trkHint.className = text ? `hint ${tone}` : "hint";
}

function addLog(entry) {
  // The log panel is collapsed by default; open it only when there is something
  // worth reading, and never let it push the controls out of the popup viewport.
  if (el.logSummary && el.logSummary.parentElement && !el.logSummary.parentElement.open) {
    el.logSummary.parentElement.open = true;
  }
  const li = document.createElement("li");
  li.className = entry.level ?? "info";

  const time = document.createElement("time");
  time.textContent = new Date(entry.t ?? Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const msg = document.createElement("span");
  msg.textContent = entry.msg ?? "";

  li.append(time, msg);
  el.log.prepend(li);
  while (el.log.children.length > 40) el.log.lastElementChild.remove();
}

/** Settings are the user's, so they persist and are applied immediately. */
async function persist() {
  const patch = {
    sensitivity: Number(el.sens.value),
    eyeSensitivity: Number(el.eyeSens.value),
    mode: el.mode.value,
    clickMode: el.clickMode.value,
    mirror: el.mirror.checked,
    snap: el.snap.checked,
  };
  await chrome.storage.local.set({
    sensitivity: patch.sensitivity,
    eyeSensitivity: patch.eyeSensitivity,
    mirror: patch.mirror,
    snap: patch.snap,
    mode: patch.mode,
    clickMode: patch.clickMode,
  });
  const r = await ask("configure", patch);
  if (r && r.ok === false) setError(r.error ?? "That setting could not be applied.");
}

el.connect.addEventListener("click", () =>
  once(el.connect, async () => {
    setStatus("Connecting…");
    setError("");
    const r = await ask("connect", { host: el.host.value.trim(), port: Number(el.port.value) });
    if (!r?.ok) {
      setStatus(r?.error ?? "Could not connect", "err");
      setError(r?.error ?? "");
    }
  }),
);

el.track.addEventListener("click", () =>
  once(el.track, async () => {
    const s = await ask("status");
    const tracking = !s.tracking;
    if (tracking) {
      // Say the camera is being asked for, so a slow permission prompt is not a dead UI.
      setPill(el.trackState, "starting", "warn");
      setTrackHint("Allow the camera in the prompt Chrome shows…", "warn");
    }
    setError("");
    const r = await ask("setTracking", { tracking });
    if (!r?.ok) {
      // A denied or missing camera permission is the most common failure and must be
      // visible on the page, not only in the service worker's console.
      setError(r?.error ?? "The camera could not be started. Check the permission in chrome://settings/content/camera.");
      setPill(el.trackState, "error", "err");
      setTrackHint(r?.error ?? "the camera could not be started", "err");
    }
  }),
);

el.listen.addEventListener("click", () =>
  once(el.listen, async () => {
    const s = await ask("status");
    const listening = !s.listening;
    if (listening) {
      setPill(el.micState, "starting", "warn");
      setStatus("Allow the microphone, then speak a command…", "warn");
    }
    setError("");
    const r = await ask("setListening", { listening });
    if (!r?.ok) {
      setError(r?.error ?? "The microphone could not be started. Check the permission in chrome://settings/content/microphone.");
      setPill(el.micState, "error", "err");
      setStatus(r?.error ?? "The microphone could not be started.", "err");
    }
  }),
);

el.recenter.addEventListener("click", () =>
  once(el.recenter, async () => {
    setPill(el.trackState, "calibrating", "warn");
    setTrackHint("Hold still and look straight ahead", "warn");
    const r = await ask("recenter");
    if (!r?.ok) setError(r?.error ?? "Re-centring failed. Is tracking on?");
  }),
);

for (const slider of [el.sens, el.eyeSens]) {
  slider.addEventListener("input", () => {
    const out = slider === el.sens ? el.sensOut : el.eyeSensOut;
    out.textContent = Number(slider.value).toFixed(1);
  });
  slider.addEventListener("change", persist);
}
for (const input of [el.mirror, el.snap, el.mode, el.clickMode]) {
  input.addEventListener("change", persist);
}

el.cmdForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = el.cmd.value.trim();
  if (!text) return;
  const r = await ask("command", { text });
  el.cmd.value = "";
  if (!r?.ok) {
    setError(r?.error ?? "Command not sent — is the server running?");
  } else {
    setError("");
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  const { type, payload } = msg ?? {};
  if (type === "status") renderStatus(payload);
  else if (type === "log") addLog(payload);
  else if (type === "action" && payload?.label) {
    addLog({ level: "act", msg: payload.label, t: Date.now() });
  }
});

(async () => {
  const saved = await chrome.storage.local
    .get(["sensitivity", "eyeSensitivity", "mirror", "snap", "mode", "clickMode"])
    .catch(() => ({}));
  el.sens.value = saved.sensitivity ?? 1;
  el.eyeSens.value = saved.eyeSensitivity ?? 1;
  el.mirror.checked = saved.mirror !== false;
  el.snap.checked = Boolean(saved.snap);
  el.mode.value = ["head", "blend", "eye"].includes(saved.mode) ? saved.mode : "head";
  el.clickMode.value = saved.clickMode === "none" ? "none" : "pinch";
  el.sensOut.textContent = Number(el.sens.value).toFixed(1);
  el.eyeSensOut.textContent = Number(el.eyeSens.value).toFixed(1);

  renderStatus(await ask("status"));
})();

// The popup is short-lived and the worker keeps running, so re-read the truth whenever
// the panel comes back to the foreground rather than trusting the values it was born with.
globalThis.addEventListener?.("focus", async () => {
  const s = await ask("status");
  if (s) renderStatus(s);
});