import assert from "node:assert/strict";
import test from "node:test";
import { openCommand } from "../../src/server.js";

test("the control page is handed to the OS default browser", () => {
  const url = "http://localhost:8787";
  assert.deepEqual(openCommand(url, "win32"), { file: "cmd", args: ["/c", "start", "", url] });
  assert.deepEqual(openCommand(url, "darwin"), { file: "open", args: [url] });
  assert.deepEqual(openCommand(url, "linux"), { file: "xdg-open", args: [url] });
});

test("win32 start gets an empty title so a quoted URL is not eaten as the window title", () => {
  const { args } = openCommand("http://localhost:8787", "win32");
  assert.equal(args[2], "", "cmd /c start treats the next quoted token as the title");
  assert.equal(args[3], "http://localhost:8787");
});