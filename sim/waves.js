/* =============================================================================
 * Circle Tower Wars — sim/waves.js
 * DETERMINISTIC WAVE GENERATION + enemy scaling, in fixed-point.
 * Pure function of (wave, corridorCount) — identical on every client. Mirrors
 * the original database.js generateWave/enemyScale tuning but emits fixed-point
 * scale factors so spawning stays bit-exact.
 * ===========================================================================*/

import { fromFloat, fromInt, mul } from "./fx.js";

// Returns spawn groups: { type, count, gap(fx sec), delay(fx sec) }
export function generateWave(wave, corridorCount, bossEvery) {
  const isBoss = wave % bossEvery === 0;
  const entries = [];
  if (isBoss) {
    entries.push({ type: "boss", count: 1, gap: 0, delay: 0 });
    const escorts = 4 + Math.floor(wave / 10) * 2;
    entries.push({ type: "brute", count: escorts, gap: fromFloat(1.1), delay: fromFloat(2) });
    entries.push({ type: "runner", count: escorts * 2, gap: fromFloat(0.5), delay: fromFloat(1) });
    return entries;
  }
  const base = 6 + Math.floor(wave * 0.7);
  entries.push({ type: "grunt", count: Math.round(base * 0.6), gap: fromFloat(0.75), delay: 0 });
  entries.push({ type: "runner", count: Math.round(3 + wave * 0.3), gap: fromFloat(0.45), delay: fromFloat(0.6) });
  if (wave >= 4) entries.push({ type: "swarm", count: Math.round(6 + wave * 0.6), gap: fromFloat(0.22), delay: fromFloat(1.4) });
  if (wave >= 6) entries.push({ type: "brute", count: 1 + Math.floor(wave / 6), gap: fromFloat(1.3), delay: fromFloat(2.2) });
  if (wave >= 12) entries.push({ type: "tank", count: Math.floor(wave / 12), gap: fromFloat(1.8), delay: fromFloat(3) });
  return entries;
}

// Fixed-point scale multipliers (all baked from authored formula).
export function enemyScale(wave) {
  const hp = 1 + (wave - 1) * 0.16 + Math.pow(wave / 12, 2) * 0.5;
  const speed = 1 + Math.min(0.5, (wave - 1) * 0.012);
  const reward = 1 + (wave - 1) * 0.03;
  return { hp: fromFloat(hp), speed: fromFloat(speed), reward: fromFloat(reward) };
}

export function totalWaves(mode, corridorCount) {
  if (mode === "endless") return 0x7fffffff;
  if (mode === "single") return 10;
  return corridorCount * 10;
}

export default { generateWave, enemyScale, totalWaves };
