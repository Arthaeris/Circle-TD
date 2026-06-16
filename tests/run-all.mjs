/* Runs every determinism / unit test and reports a combined result. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const tests = ["test-fx-rng.mjs", "test-determinism.mjs", "test-lockstep.mjs", "test-content-gate.mjs"];
let allOk = true;
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(__dirname, t)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) { allOk = false; process.stderr.write(r.stderr || ""); }
}
console.log("\n==== " + (allOk ? "ALL TESTS PASSED" : "SOME TESTS FAILED") + " ====");
process.exit(allOk ? 0 : 1);
