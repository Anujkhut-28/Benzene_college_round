import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { matchMacro, loadMacros, MACRO_FILE } from "../../src/macros.js";

function withMacros(body) {
  fs.writeFileSync(MACRO_FILE, JSON.stringify({ timesheet: ["go to example dot com", "show numbers", "click 3"], email: ["go to gmail dot com"] }));
  loadMacros({ force: true });
  try {
    return body();
  } finally {
    fs.rmSync(MACRO_FILE, { force: true });
    loadMacros({ force: true });
  }
}

test("a macro is triggered by 'do <name>' in several phrasings", () => {
  withMacros(() => {
    for (const p of ["do my timesheet", "run the timesheet", "start timesheet", "do my timesheet macro", "Do My Timesheet."]) {
      assert.equal(matchMacro(p)?.name, "timesheet", `"${p}" should run the timesheet macro`);
    }
    assert.equal(matchMacro("do my timesheet").steps.length, 3);
    assert.equal(matchMacro("do my email macro").name, "email");
    // Ordinary commands must not be mistaken for macros.
    for (const p of ["go to wikipedia", "do my laundry", ""]) {
      assert.equal(matchMacro(p), null, `"${p}" is not a macro`);
    }
  });
});

test("a missing or broken macros.json is never fatal", () => {
  // Missing file: no macros, no errors, no throw.
  fs.rmSync(MACRO_FILE, { force: true });
  const missing = loadMacros({ force: true });
  assert.deepEqual(missing.macros, {});
  assert.deepEqual(missing.errors, []);
  assert.equal(matchMacro("do my timesheet"), null);

  withMacros(() => {
    // Bad entries are reported and skipped; the good ones still load.
    fs.writeFileSync(MACRO_FILE, JSON.stringify({ good: ["a"], notAList: "x", empty: [], numbers: [1, 2] }));
    const r = loadMacros({ force: true });
    assert.deepEqual(r.macros.good, ["a"]);
    assert.equal(r.errors.length, 3, "each bad entry is reported");

    // Invalid JSON is one error, not a crash.
    fs.writeFileSync(MACRO_FILE, "{ not json at all");
    const broken = loadMacros({ force: true });
    assert.equal(broken.errors.length, 1);
    assert.deepEqual(broken.macros, {});
  });
});
