/* =============================================================================
 * Circle Tower Wars — database-ext.js
 * Non-destructive AUGMENTATION of window.DB. Loaded AFTER database.js, it adds
 * the game-mode list and the competitive send-economy tuning (D8/D11/D12, §8)
 * plus the content-gating version fields (§6.4), without modifying the original
 * database.js. (Merge these blocks back into database.js when convenient.)
 * ===========================================================================*/
(function (global) {
  "use strict";
  const DB = global.DB;
  if (!DB) { console.error("database-ext.js: window.DB missing — load database.js first"); return; }

  // D8 — three modes.
  if (!DB.GAME_MODES) DB.GAME_MODES = ["solo", "coop", "competitive"];

  // §8 — competitive send-economy tuning (plain data; the sim-core reads it).
  // D12: sentBountyMult is a FIXED higher reward for killing a sent enemy — it
  // does NOT rise per sent enemy. Anti-snowball (§8.3) uses rising send cost +
  // catch-up income for the trailing player, never the defender bounty.
  if (!DB.COMPETITIVE) {
    DB.COMPETITIVE = {
      sendBaseCost: 40,
      sendCostGrowth: 1.15,        // §8.3 rising send cost
      incomePerSend: 2,            // §8.1 sending builds passive income
      incomeIntervalTicks: 150,    // payout every 5s @30Hz
      sentBountyMult: 1.6,         // §8.2 fixed higher bounty
      maxActiveSentPerTarget: 30,  // §8.3 cap
      catchupPerLifeBehind: 1,     // §8.3 catch-up income
      sendableEnemies: ["grunt", "runner", "swarm", "brute"],
    };
  }

  // §6.4 — content-gating version fields.
  if (DB.codeVersion == null) DB.codeVersion = 2; // deterministic-core rebuild
  if (DB.contentHash === undefined) DB.contentHash = null; // filled by hashContent at boot
})(typeof window !== "undefined" ? window : this);
