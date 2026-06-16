/* Content hash + gating (§6.4): DB loaded with database-ext must produce a
 * stable content hash; identical content gates OK, changed balancing gates out. */
import { loadDB } from "./load-db.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashContent } from "../sim/hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// load DB then apply database-ext.js to the same window object
function loadFullDB() {
  const dbCode = readFileSync(join(__dirname, "..", "database.js"), "utf8");
  const extCode = readFileSync(join(__dirname, "..", "database-ext.js"), "utf8");
  const win = {};
  new Function("window", dbCode + "\n" + extCode + "\n;return window.DB;")(win);
  return win.DB;
}

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  FAIL:", n)); };

const DB = loadFullDB();
ok("database-ext added COMPETITIVE", !!DB.COMPETITIVE);
ok("database-ext added GAME_MODES (3)", Array.isArray(DB.GAME_MODES) && DB.GAME_MODES.length === 3);
ok("codeVersion present", DB.codeVersion === 2);

const h1 = hashContent(DB);
const h2 = hashContent(loadFullDB());
ok("content hash stable across loads", h1 === h2);
ok("content hash is 8 hex chars", /^[0-9a-f]{8}$/.test(h1));

// simulate a client with tampered balancing -> different hash -> gating blocks
const DB2 = loadFullDB(); DB2.CONFIG.startGold += 10;
ok("changed balancing => different content hash", hashContent(DB2) !== h1);

console.log("\ncontent-gate: " + pass + " passed, " + fail + " failed  (hash=" + h1 + ")");
process.exit(fail ? 1 : 0);
