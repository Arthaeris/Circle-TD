/* =============================================================================
 * Circle Tower Wars — sim/balance.js
 * Converts the authored, human-readable DB (database.js) into a FIXED-POINT
 * balancing table the sim-core consumes (§3: the core reads balancing only as
 * data, never hardcoded). This conversion runs ONCE at load on every client
 * from the identical authored numbers, so the resulting fixed values are
 * identical everywhere — determinism is preserved.
 *
 * The sim-core never imports database.js directly; the shell builds `bal` with
 * buildBalance(DB) and hands it to the core. This keeps the core engine-free
 * and unit-testable with a fixture in Node.
 * ===========================================================================*/

import { fromFloat, fromInt } from "./fx.js";

const F = fromFloat;

export function buildBalance(DB) {
  const C = DB.CONFIG;
  const bal = {
    grid: { cols: C.grid.cols, rows: C.grid.rows },
    portalCols: C.portalCols.slice(),
    towerSize: C.towerSize,
    startLives: C.startLives,
    startGold: C.startGold,
    startEssence: C.startEssence,
    enemyBaseSpeed: F(C.enemyBaseSpeed),     // tiles/sec, fixed
    sellRefund: F(C.sellRefund),
    maxLevel: C.maxLevel,
    maxExpert: C.maxExpert,
    expertThresholds: C.expertThresholds.slice(),
    expertDamageBonus: C.expertDamageBonus.map(F),
    bossEvery: C.bossEvery,
    obstacleDensity: F(C.obstacleDensity),
    loopLifeLoss: C.loopLifeLoss,
    // Early-call bonus (integers; tolerate older DBs lacking it).
    earlyCall: {
      base: (C.earlyCallBonus && C.earlyCallBonus.base) != null ? C.earlyCallBonus.base : 20,
      perWave: (C.earlyCallBonus && C.earlyCallBonus.perWave) != null ? C.earlyCallBonus.perWave : 6,
    },

    scaling: {
      damagePerLevel: F(DB.SCALING.damagePerLevel),
      fireRatePerLevel: F(DB.SCALING.fireRatePerLevel),
      rangePerLevel: F(DB.SCALING.rangePerLevel),
      upgradeCostBase: F(DB.SCALING.upgradeCostBase),
      costGrowth: F(DB.SCALING.costGrowth),
    },

    elementOrder: DB.ELEMENT_ORDER.slice(),
    elements: {},
    statuses: {},
    synergies: {},
    towers: {},
    enemies: {},
    // Competitive send-economy (§8); tolerate older DBs lacking it.
    competitive: normalizeCompetitive(DB.COMPETITIVE),
  };

  for (const id of DB.ELEMENT_ORDER) {
    const e = DB.ELEMENTS[id];
    bal.elements[id] = { id, currency: e.currency, starter: !!e.starter };
  }

  for (const k in DB.STATUSES) {
    const s = DB.STATUSES[k];
    bal.statuses[k] = {
      id: s.id, kind: s.kind, element: s.element || null,
      value: F(s.value || 0), duration: F(s.duration || 0),
      adaptive: !!s.adaptive,
    };
  }

  for (const k in DB.SYNERGIES) {
    const s = DB.SYNERGIES[k];
    bal.synergies[k] = {
      name: s.name,
      burst: s.burst != null ? F(s.burst) : 0,
      dotMult: s.dotMult != null ? F(s.dotMult) : 0,
      curseBoost: s.curseBoost != null ? F(s.curseBoost) : 0,
      execute: s.execute != null ? F(s.execute) : 0,
      spread: !!s.spread,
      anchor: !!s.anchor,
    };
  }

  for (const t of DB.TOWERS) {
    bal.towers[t.id] = {
      id: t.id, element: t.element, archetype: t.archetype,
      slot: t.slot != null ? t.slot : 0,
      cost: t.cost,
      damage: F(t.damage || 0),
      range: F(t.range || 0),
      fireRate: F(t.fireRate || 0),
      splashRadius: F(t.splashRadius || 0),
      chainCount: t.chainCount || 0,
      chainRange: F(t.chainRange || 0),
      pierce: t.pierce || 0,
      projectileSpeed: F(t.projectileSpeed || 12),
      status: t.status || null,
      statusChance: F(t.statusChance || 0),
      statusDuration: F(t.statusDuration || 0),
      auraStat: t.auraStat || null,
      auraValue: F(t.auraValue || 0),
      mutations: (t.mutations || []).map(m => ({ id: m.id, mods: convertMods(m.mods) })),
    };
  }

  for (const k in DB.ENEMIES) {
    const e = DB.ENEMIES[k];
    bal.enemies[k] = {
      id: e.id, hp: F(e.hp), speed: F(e.speed), armor: F(e.armor || 0),
      reward: e.reward, radius: F(e.radius), boss: !!e.boss, end: !!e.end,
    };
  }

  return bal;
}

function convertMods(mods) {
  const out = {};
  for (const k in mods) {
    const v = mods[k];
    if (typeof v === "number") {
      // ints stay ints for count-like mods; fractions go fixed
      out[k] = (k === "chainCount" || k === "pierce") ? (v | 0) : fromFloat(v);
    } else {
      out[k] = v; // strings (e.g. archetype, addStatus, auraStat)
    }
  }
  return out;
}

function normalizeCompetitive(C) {
  C = C || {};
  return {
    sendBaseCost: C.sendBaseCost != null ? C.sendBaseCost : 40,
    sendCostGrowth: fromFloat(C.sendCostGrowth != null ? C.sendCostGrowth : 1.15), // §8.3 rising send cost
    incomePerSend: C.incomePerSend != null ? C.incomePerSend : 2,                  // §8.1 builds passive income
    incomeIntervalTicks: C.incomeIntervalTicks != null ? C.incomeIntervalTicks : 150, // 5s @30hz
    sentBountyMult: fromFloat(C.sentBountyMult != null ? C.sentBountyMult : 1.6),  // §8.2 FIXED higher bounty (not rising)
    maxActiveSentPerTarget: C.maxActiveSentPerTarget != null ? C.maxActiveSentPerTarget : 30, // §8.3 cap
    catchupPerLifeBehind: C.catchupPerLifeBehind != null ? C.catchupPerLifeBehind : 1, // §8.3 catch-up income
  };
}

export default { buildBalance };
