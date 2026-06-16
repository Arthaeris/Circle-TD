/* =============================================================================
 * Build step (§2/§11) — bundles + minifies the ES module engine for production.
 * Optional: the game also runs UNBUNDLED directly from index.html (the browser
 * loads the ES modules natively), so you can develop with zero build. Run a
 * production bundle with:  npm install && npm run build
 * Output: dist/ctw.min.js  (point a <script type="module"> at it if you prefer
 * a single file). Requires esbuild (listed in devDependencies).
 * ===========================================================================*/
import { build } from "esbuild";

await build({
  entryPoints: ["app/main.js"],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2020"],
  outfile: "dist/ctw.min.js",
  legalComments: "none",
}).then(() => console.log("Built dist/ctw.min.js"))
  .catch((e) => { console.error(e); process.exit(1); });
