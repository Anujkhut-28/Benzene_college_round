import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// User-defined macros: named groups of commands you can trigger with one phrase.
//
// This exists because some journeys are the same every time - open the timesheet, filter to this
// month, export it. Spelling that out in words every morning is exactly the kind of thing that
// makes hands-free control feel worse than a keyboard.
//
// Macros are a flat list of command strings run in order, each going through the same recognise
// -> policy -> execute path as anything spoken. A macro cannot do anything the user cannot already
// do by voice, and each step is still subject to the confirmation gate.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MACRO_FILE = path.resolve(HERE, "..", "macros.json");

const EXAMPLE = {
  timesheet: ["go to example dot com", "show numbers", "click 3", "search for this month", "press enter"],
  email: ["go to gmail dot com", "show numbers", "click 1"],
};

let cache = null;

/** Read macros.json. A missing or broken file is not fatal - macros are optional. */
export function loadMacros({ force = false } = {}) {
  if (cache && !force) return cache;
  cache = { macros: {}, errors: [] };
  let raw;
  try {
    raw = fs.readFileSync(MACRO_FILE, "utf8");
  } catch {
    return cache; // no file: no macros, which is a perfectly good default
  }
  try {
    const parsed = JSON.parse(raw);
    for (const [name, steps] of Object.entries(parsed || {})) {
      if (!Array.isArray(steps) || !steps.length) {
        cache.errors.push(`"${name}" is not a non-empty list`);
        continue;
      }
      if (!steps.every((s) => typeof s === "string" && s.trim())) {
        cache.errors.push(`"${name}" has a step that is not a string`);
        continue;
      }
      cache.macros[String(name).toLowerCase()] = steps.map((s) => s.trim());
    }
  } catch (err) {
    cache.errors.push(`macros.json is not valid JSON: ${err.message}`);
  }
  return cache;
}

/** "do my timesheet" -> the macro's steps, or null. */
export function matchMacro(transcript) {
  const t = String(transcript || "")
    .toLowerCase()
    .replace(/[.,!?]/g, "")
    .trim();
  if (!t) return null;
  const { macros } = loadMacros();
  // "do my timesheet", "run timesheet", "start the timesheet macro"
  const m = t.match(/^(?:do|run|start|open|play|execute)\s+(?:my\s+|the\s+|a\s+)?(.+?)(?:\s+(?:macro|shortcut|sequence|script))?$/);
  if (!m) return null;
  const name = m[1].trim();
  const steps = macros[name];
  return steps ? { name, steps } : null;
}

export function writeExampleMacros() {
  fs.writeFileSync(MACRO_FILE, JSON.stringify(EXAMPLE, null, 2) + "\n");
  return MACRO_FILE;
}
