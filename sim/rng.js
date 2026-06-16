/* =============================================================================
 * Circle Tower Wars — sim/rng.js
 * SEEDED DETERMINISTIC PRNG (Decision D5, §5).
 *
 * Two SEPARATE streams must never be confused:
 *   - SIM stream:   everything state-changing (wave generation, enemy variance,
 *                   crit rolls, obstacle placement, sent-enemy type/position,
 *                   targeting tie-breaks). Seeded; shared across all clients in
 *                   multiplayer; advances ONLY inside the sim step.
 *   - COSMETIC stream: pure visuals (particle jitter, screen flash). May use
 *                   Math.random freely OUTSIDE the core; never touches state.
 *
 * Algorithm: mulberry32 — tiny, fast, good distribution, fully integer-defined
 * so it is bit-identical on every JS engine. The generator's `s` (uint32) is
 * part of the serializable sim state, so a saved/loaded or networked run
 * resumes the exact same random sequence.
 * ===========================================================================*/

import { ONE } from "./fx.js";

// A stream is just { s } so it serializes trivially into the sim state.
export function makeStream(seed) {
  return { s: (seed >>> 0) || 1 };
}

// advance & return uint32
export function nextU32(st) {
  let a = (st.s + 0x6d2b79f5) | 0;
  st.s = a >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

// float in [0,1) — DERIVED from u32, deterministic. Avoid for state where you
// can use fixed-point; provided for convenience in non-arithmetic decisions.
export function nextFloat(st) {
  return nextU32(st) / 4294967296;
}

// fixed-point value in [0, ONE)
export function nextFixed(st) {
  return (nextU32(st) >>> 16) & 0xffff; // top 16 bits -> fractional part
}

// integer in [0, n)
export function nextInt(st, n) {
  if (n <= 0) return 0;
  return nextU32(st) % n;
}

// integer in [lo, hi] inclusive
export function rangeInt(st, lo, hi) {
  if (hi <= lo) return lo;
  return lo + nextInt(st, hi - lo + 1);
}

// fixed-point value in [loFx, hiFx)
export function rangeFixed(st, loFx, hiFx) {
  const span = hiFx - loFx;
  return loFx + Math.trunc((nextU32(st) * span) / 4294967296);
}

// uniform pick from an array (deterministic by index)
export function pick(st, arr) {
  return arr[nextInt(st, arr.length)];
}

// roll a probability given as a fixed-point chance in [0,ONE]
export function chance(st, pFx) {
  return nextFixed(st) < pFx;
}

export default {
  makeStream, nextU32, nextFloat, nextFixed, nextInt, rangeInt, rangeFixed, pick, chance,
};
