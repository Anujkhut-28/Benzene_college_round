import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MODEL_DIR = path.resolve(PACKAGE_ROOT, process.env.HANDSFREE_MODEL_DIR || "models");

const MODEL_FILE = "Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf";
const LMSTUDIO_GLOB = "Jev-Style-0.8B-Decision-v3";
const EXTRA_DIRS = [
  path.join(os.homedir(), ".lmstudio", "models"),
  path.join(os.homedir(), ".cache", "lm-studio", "models"),
];

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.name.toLowerCase().endsWith(".gguf")) out.push(p);
  }
  return out;
}

/** Find a usable decision-model GGUF without requiring LM Studio to be running. */
export function findModel() {
  const explicit = process.env.HANDSFREE_MODEL;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`HANDSFREE_MODEL not found: ${explicit}`);
    return explicit;
  }

  const bundled = path.join(MODEL_DIR, MODEL_FILE);
  if (fs.existsSync(bundled)) return bundled;

  const roots = [MODEL_DIR, ...EXTRA_DIRS].filter((d) => fs.existsSync(d));
  const found = roots.flatMap((r) => walk(r));
  const match = found.find((f) => path.basename(f).startsWith(LMSTUDIO_GLOB)) || found[0];
  if (match) return match;

  throw new Error(
    `No decision model found. Put ${MODEL_FILE} in ${MODEL_DIR}, or set HANDSFREE_MODEL to a .gguf path.\n` +
      `Searched: ${roots.join(", ") || "(none exist)"}`,
  );
}

export function modelInfo() {
  try {
    const p = findModel();
    return { path: p, sizeBytes: fs.statSync(p).size, bundled: p.startsWith(MODEL_DIR) };
  } catch (err) {
    return { path: null, error: String(err.message || err) };
  }
}