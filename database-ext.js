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

  // D8 — four modes ("versus" = offline vs NPC rivals, Line-Tower-Wars style).
  if (!DB.GAME_MODES) DB.GAME_MODES = ["solo", "coop", "competitive", "versus"];

  // ---------------------------------------------------------------------------
  // SENDS — the sendable-mob catalog for competitive & versus modes.
  // FLAT cost per type+level (no rising per-purchase cost). Each type can be
  // upgraded to level 5; every level raises both send cost and mob strength.
  // ---------------------------------------------------------------------------
  if (!DB.SENDS) {
    DB.SENDS = {
      grunt:  { baseCost: 15,  count: 1, costGrowth: 1.6, hpGrowth: 1.8, desc: "Cheap, steady filler" },
      runner: { baseCost: 25,  count: 1, costGrowth: 1.6, hpGrowth: 1.8, desc: "Fast — punishes slow towers" },
      swarm:  { baseCost: 40,  count: 4, costGrowth: 1.6, hpGrowth: 1.8, desc: "A pack of 4 — floods single-target" },
      brute:  { baseCost: 70,  count: 1, costGrowth: 1.6, hpGrowth: 1.8, desc: "Armored bruiser" },
      tank:   { baseCost: 130, count: 1, costGrowth: 1.6, hpGrowth: 1.8, desc: "Heavily armored wall" },
    };
    DB.SEND_MAX_LEVEL = 5;
    // Shared authored formulas (UI, bots and balance all use these):
    DB.sendCost = (type, lvl) => { const s = DB.SENDS[type]; return s ? Math.round(s.baseCost * Math.pow(s.costGrowth, lvl - 1)) : 0; };
    DB.sendUpgradeCost = (type, lvl) => { const s = DB.SENDS[type]; return s ? Math.round(s.baseCost * 4 * lvl) : 0; }; // lvl -> lvl+1
    DB.sendHpMult = (type, lvl) => { const s = DB.SENDS[type]; return s ? Math.pow(s.hpGrowth, lvl - 1) : 1; };
  }

  // §8 — competitive send-economy tuning (plain data; the sim-core reads it).
  // D12: sentBountyMult is a FIXED higher reward for killing a sent enemy — it
  // does NOT rise per sent enemy. Anti-snowball (§8.3) uses rising send cost +
  // catch-up income for the trailing player, never the defender bounty.
  if (!DB.COMPETITIVE) {
    DB.COMPETITIVE = {
      incomeRate: 0.06,            // §8.1 income gained per gold spent on sends
      incomeIntervalTicks: 150,    // payout every 5s @30Hz
      sentBountyMult: 1.6,         // §8.2 fixed higher bounty
      maxActiveSentPerTarget: 40,  // §8.3 cap
      catchupPerLifeBehind: 1,     // §8.3 catch-up income
    };
  }

  // Early-call bonus: reward for starting the next wave while the previous is
  // still being fought (plain data; the sim-core reads it via buildBalance).
  if (!DB.CONFIG.earlyCallBonus) DB.CONFIG.earlyCallBonus = { base: 20, perWave: 6 };

  // §6.4 — content-gating version fields.
  if (DB.codeVersion == null) DB.codeVersion = 4; // v4: flat send levels, versus mode
  if (DB.contentHash === undefined) DB.contentHash = null; // filled by hashContent at boot
})(typeof window !== "undefined" ? window : this);
