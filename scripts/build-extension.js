/**
 * Builds the extension's copy of the head tracker.
 *
 * `src/public/head-tracker.js` is an ES module (the control page imports it), but MV3
 * content scripts are classic scripts and cannot use `export`/`import`. This reads the
 * source, strips the `export` keywords and wraps it so it assigns to a global.
 *
 * Run automatically from `npm run build:extension`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src", "public", "head-tracker.js");
const OUT = path.join(ROOT, "extension", "head-tracker-core.js");

export function buildTrackerCore() {
  const src = fs.readFileSync(SRC, "utf8");

  if (/^\s*import\s/m.test(src) || /\bexport\s*\{/.test(src)) {
    throw new Error("head-tracker.js gained an import/export block; update build-extension.js");
  }

  // `export class X` / `export function X` -> `class X` / `function X`
  const body = src.replace(/^export\s+(?=(class|function|const|let|var)\b)/gm, "");

  const out = `/**
 * GENERATED FILE - do not edit. Produced by scripts/build-extension.js from
 * src/public/head-tracker.js. Edit the source and run \`npm run build:extension\`.
 */
/* eslint-disable */
(function (global) {
${body}
  global.HandsFreeHeadTracker = { HeadTracker, OneEuro, applySmoothDeadzone, trimmedMean };
})(typeof globalThis !== "undefined" ? globalThis : self);
`;

  fs.writeFileSync(OUT, out);
  return { path: OUT, bytes: Buffer.byteLength(out) };
}

/**
 * MV3 content scripts are classic scripts. An `export` left in any of them is a
 * SyntaxError at parse time, which means the whole file silently never runs - the
 * extension loads, the buttons render, and nothing works. Catch that here.
 */
export function checkClassicScripts() {
  const EXT = path.join(ROOT, "extension");
  // background.js is declared `"type": "module"` in the manifest, so ESM is legal there.
  // Everything else runs as a classic script where `export` is a fatal SyntaxError.
  const scripts = ["content.js", "page-bridge.js", "offscreen.js", "popup.js"];
  const problems = [];
  for (const name of scripts) {
    const file = path.join(EXT, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name}: missing`);
      continue;
    }
    const src = fs.readFileSync(file, "utf8");
    if (/^\s*export\s/m.test(src) || /^\s*import\s+[\w{*]/m.test(src)) {
      problems.push(`${name}: contains import/export, but this file runs as a classic script`);
    }
  }
  const core = path.join(EXT, "head-tracker-core.js");
  if (!fs.existsSync(core)) {
    problems.push("head-tracker-core.js: missing (run `npm run build:extension`)");
  } else if (/^\s*export\s/m.test(fs.readFileSync(core, "utf8"))) {
    problems.push("head-tracker-core.js: contains export");
  }
  return problems;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const res = buildTrackerCore();
  console.log(`head-tracker-core.js  ${(res.bytes / 1024).toFixed(0)} KB -> ${res.path}`);
  const problems = checkClassicScripts();
  if (problems.length) {
    console.error("\nextension build problems:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("extension scripts OK (no import/export in classic scripts)");
}