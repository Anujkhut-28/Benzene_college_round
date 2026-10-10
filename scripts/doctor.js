import { status, ping } from "../src/doctor.js";

const s = await status();
if (!s.path) {
  console.error(`No model found.\n${s.error}`);
  process.exit(1);
}

console.log(`model   ${s.path}`);
console.log(`size    ${(s.sizeBytes / 1024 / 1024).toFixed(0)} MB`);

const t0 = Date.now();
const r = await ping();
if (!r.ok) {
  console.error(`load failed: ${r.error}`);
  process.exit(1);
}
console.log(`device  ${r.device} (${r.architecture})`);
console.log(`loaded  ${Date.now() - t0} ms`);
console.log("\nOK - run `npm start` and open http://localhost:8787");