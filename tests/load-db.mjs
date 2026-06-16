/* Loads the browser-style database.js into Node by giving it a fake `window`.
 * database.js ends with: })(typeof window !== "undefined" ? window : this);
 * so passing a `window` object captures global.DB into it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadDB(path) {
  const code = readFileSync(path || join(__dirname, "..", "database.js"), "utf8");
  const fn = new Function("window", code + "\n;return window.DB;");
  return fn({});
}
export default loadDB;
