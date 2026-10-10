/**
 * Node server: serves the control page, bridges WebSocket <-> Controller, owns the API key.
 *
 *   node src/server.js [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://127.0.0.1:9222/devtools/browser/...] [--start-url https://...]
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser.js";
import { Controller } from "./controller.js";
import { hasApiKey, BACKEND } from "./jev.js";
import { MODEL, QUESTIONS, T } from "./constants.js";

import { spawn } from "node:child_process";
import { platform } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The control page needs Chrome/Edge for the mic, so hand it to the OS default.
export function openCommand(url, os = platform()) {
  if (os === "win32") return { file: "cmd", args: ["/c", "start", "", url] };
  if (os === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}

function openControlPage(url) {
  const cmd = openCommand(url);
  spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref();
}

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    // Bind to loopback only by default: anyone who can reach this port can drive the browser
    // and spend your API credits. Use --host 0.0.0.0 deliberately if you need LAN access.
    host: process.env.HOST || "127.0.0.1",
    headless: false,
    cdp: null,
    startUrl: "https://example.com/",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
  }
  return out;
}

export async function startServer(opts = {}) {
  if (!hasApiKey()) {
    console.error("Missing TYPESAFE_API_KEY (or JEV_API_KEY). Use ./run.sh or export it first.");
    console.error("No key? Run a local decision model instead: JEV_BACKEND=local LMSTUDIO_URL=http://127.0.0.1:1234");
    process.exit(1);
  }
  const browser = new BrowserManager();
  await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });

  if (BACKEND === "local") {
    const { getRuntime } = await import("./runtime.js");
    console.log("loading decision model (embedded, no API key)...");
    try {
      const rt = await getRuntime();
      console.log(`model ready on ${rt.device} · ${rt.modelPath}`);
    } catch (err) {
      console.error(`could not load the decision model: ${String(err.message || err).split("\n")[0]}`);
      process.exit(1);
    }
  }

  const controller = new Controller({ browser });
  await controller.start();

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({ model: MODEL, thresholds: T, questions: QUESTIONS }));
  app.get("/api/browser", (_req, res) =>
    res.json({ connected: browser.isConnected(), hasPages: browser.hasPages(), tabs: browser.tabInfo() }),
  );
  app.post("/api/browser/reopen", async (_req, res) => {
    try {
      if (!browser.isConnected()) {
        await browser.relaunch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });
      } else {
        await browser.reopen();
      }
      await controller.refreshSnapshot();
      res.json({ ok: true, url: browser.currentUrl(), tabs: browser.tabInfo() });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("tabs", (p) => broadcast("tabs", p));

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // One bad message must never take the server down: pointer messages arrive every frame
      // and any rejection here would otherwise surface as an unhandled rejection and exit Node.
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error(`ws ${msg?.type} failed: ${err?.message || err}`);
      }
    });

    async function handleMessage(msg) {
      switch (msg.type) {
        case "transcript":
          controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId });
          break;
        case "command":
          controller.handleCommand(msg.text);
          break;
        case "undo":
          controller.undo();
          break;
        case "snapshot":
          controller.refreshSnapshot();
          break;
        case "pointer":
          await browser.pointer(msg).catch(() => {});
          // A pinch click can navigate; refresh so voice commands see the new page.
          if (msg.click) setTimeout(() => controller.refreshSnapshot().catch(() => {}), 700);
          break;
        case "click":
          await browser.clickElement(msg.elementId, { source: "pointer" }).catch(() => {});
          break;
        case "reopen": {
          const health = await fetch(`http://${host}:${opts.port}/api/browser/reopen`, { method: "POST" }).catch(() => null);
          ws.send(JSON.stringify({ type: "browser", payload: health ? await health.json().catch(() => ({ ok: false })) : { ok: false, error: "unreachable" } }));
          break;
        }
        case "state":
          ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
          break;
        default:
          break;
      }
    }
  });

  const host = opts.host || "127.0.0.1";
  await new Promise((resolve) => server.listen(opts.port, host, resolve));
  const url = `http://localhost:${opts.port}`;
  if (!opts.headless) openControlPage(url);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`WARNING: listening on ${host} — anyone who can reach this port can control the browser and spend API credits.`);
  }
  if (BACKEND === "local") {
    const { runtimeState } = await import("./runtime.js");
    const rt = runtimeState();
    console.log(`backend embedded · ${rt.modelPath?.split(/[\\/]/).pop()} on ${rt.device} · no API key, no cost`);
  } else {
    console.log(`backend api · ${MODEL} · uses your TYPESAFE_API_KEY`);
  }
  console.log(`\nHandsFree ready → open ${url} in Chrome (mic needs Chrome/Edge)`);
  console.log(`controlled window: ${opts.cdp ? "attached via CDP" : opts.headless ? "headless" : "headed Chromium"}\n`);

  const shutdown = async () => {
    await controller.close();
    await browser.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { app, server, controller, browser, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
