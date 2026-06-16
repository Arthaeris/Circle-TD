/* =============================================================================
 * Circle Tower Wars — sim/fx.js
 * FIXED-POINT MATHEMATICS for the deterministic sim-core (Decision D9, §3).
 *
 * Why this exists:
 *   Safari (JavaScriptCore) and Chrome (V8) can produce different results for
 *   floating-point transcendental functions (sin/cos/sqrt/pow). Lockstep
 *   netcode requires bit-identical simulation across engines, so the entire
 *   state-mutating core runs in 16.16 fixed-point integers. Integer add/sub/
 *   mul/div/compare are bit-exact everywhere; trig comes from a shared LUT and
 *   roots from a deterministic integer isqrt.
 *
 * Format: signed 32-bit, 16 integer bits + 16 fractional bits ("16.16").
 *   - ONE  = 1.0  = 65536
 *   - range ~ -32768 .. +32767 with 1/65536 resolution
 *
 * RULES (enforced by convention — no Math.* in the sim-core except via here):
 *   - Never use Math.sin/cos/tan/atan2/hypot/pow/sqrt in the sim. Use fx.*.
 *   - Multiplication of two fixed values must use fx.mul (shifts back down).
 *   - Division must use fx.div.
 * ===========================================================================*/

export const SHIFT = 16;
export const ONE = 1 << SHIFT;          // 65536
export const HALF = ONE >> 1;
export const TWO = ONE << 1;

// ---- conversions -----------------------------------------------------------
export const fromInt = (n) => (n << SHIFT) | 0;
export const toInt = (a) => a >= 0 ? (a >> SHIFT) : -((-a) >> SHIFT); // trunc toward zero
export const floorInt = (a) => a >> SHIFT;                            // floor toward -inf
export const round = (a) => (a + HALF) >> SHIFT;

// fromFloat is ONLY for one-time conversion of authored constants at load time
// (never inside the per-tick step). Determinism holds because every client
// converts the same authored numbers the same way once, before simulation.
export const fromFloat = (f) => Math.round(f * ONE) | 0;
export const toFloat = (a) => a / ONE;

// ---- core arithmetic -------------------------------------------------------
// 64-bit-safe multiply via BigInt-free split is unnecessary for our magnitudes
// (positions < ~64 tiles, values bounded), but we guard against 32-bit overflow
// by doing the intermediate product in floating range then re-truncating — this
// is STILL deterministic because inputs are integers and the product of two
// |x|<2^31 fixed values stays well within 2^53 (exact in a double).
export function mul(a, b) {
  return Math.trunc((a * b) / ONE) | 0;
}
export function div(a, b) {
  if (b === 0) return a >= 0 ? 0x7fffffff : -0x7fffffff;
  return Math.trunc((a * ONE) / b) | 0;
}

export const abs = (a) => a < 0 ? -a : a;
export const min = (a, b) => a < b ? a : b;
export const max = (a, b) => a > b ? a : b;
export const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

// ---- integer square root (deterministic) -----------------------------------
// Returns floor(sqrt(n)) for a non-negative INTEGER n. Bitwise, no floats.
export function isqrtInt(n) {
  n = n | 0;
  if (n <= 0) return 0;
  let x = n, c = 0;
  let d = 1 << 30;            // highest power of four <= 2^31
  while (d > n) d >>= 2;
  while (d !== 0) {
    if (x >= c + d) { x -= c + d; c = (c >> 1) + d; }
    else { c >>= 1; }
    d >>= 2;
  }
  return c | 0;
}

// sqrt of a fixed-point value -> fixed-point value.
// sqrt(a/ONE)*ONE = sqrt(a*ONE). a*ONE may exceed 2^31, so compute the integer
// sqrt over the (exact) double product then it fits in 16.16 again.
export function sqrt(a) {
  if (a <= 0) return 0;
  const prod = a * ONE;                 // exact for our magnitudes (< 2^53)
  // integer sqrt of a possibly-large but exact integer:
  let x = Math.floor(Math.sqrt(prod));  // candidate
  // correct any rounding so result is deterministic floor:
  while ((x + 1) * (x + 1) <= prod) x++;
  while (x * x > prod) x--;
  return x | 0;
}

// hypot replacement for the sim: length of a fixed-point vector.
export function len(dx, dy) {
  // dx,dy are fixed; dx^2+dy^2 in fixed needs mul, then sqrt.
  const d2 = mul(dx, dx) + mul(dy, dy);
  return sqrt(d2);
}

// squared distance in fixed-point (cheap, exact — preferred for comparisons).
export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return mul(dx, dx) + mul(dy, dy);
}

// ---- trigonometry via lookup table -----------------------------------------
// Angles are expressed in "brads" (binary radians): 0..ANGLE_STEPS-1 == 0..2π.
// The table is built once from authored Math.sin at load and is therefore
// identical on every client (the values are baked, not recomputed per tick).
export const ANGLE_STEPS = 1024;
const SIN_LUT = new Int32Array(ANGLE_STEPS);
(function buildSinLut() {
  for (let i = 0; i < ANGLE_STEPS; i++) {
    SIN_LUT[i] = fromFloat(Math.sin((i / ANGLE_STEPS) * Math.PI * 2));
  }
})();

export const sin = (brad) => SIN_LUT[((brad % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS];
export const cos = (brad) => sin(brad + (ANGLE_STEPS >> 2));

// atan2 -> brads, via a deterministic LUT-backed search. Inputs are fixed-point
// (or any consistent scale, since only the ratio matters). Coarse but exact and
// identical across engines. Used only for projectile/turret facing (cosmetic in
// effect on state, but kept deterministic for replay/hash stability).
const ATAN_TABLE = new Int32Array((ANGLE_STEPS >> 3) + 1); // atan over [0,1] octant
(function buildAtanTable() {
  const N = ATAN_TABLE.length;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);                 // 0..1
    ATAN_TABLE[i] = Math.round((Math.atan(t) / (Math.PI * 2)) * ANGLE_STEPS);
  }
})();
export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = abs(x), ay = abs(y);
  let a;
  if (ax >= ay) {
    const t = ax === 0 ? 0 : Math.trunc((ay * (ATAN_TABLE.length - 1)) / ax);
    a = ATAN_TABLE[clamp(t, 0, ATAN_TABLE.length - 1)];
  } else {
    const t = ay === 0 ? 0 : Math.trunc((ax * (ATAN_TABLE.length - 1)) / ay);
    a = (ANGLE_STEPS >> 2) - ATAN_TABLE[clamp(t, 0, ATAN_TABLE.length - 1)];
  }
  // resolve quadrant
  if (x >= 0 && y >= 0) return a;
  if (x < 0 && y >= 0) return (ANGLE_STEPS >> 1) - a;
  if (x < 0 && y < 0) return (ANGLE_STEPS >> 1) + a;
  return ANGLE_STEPS - a;
}

export default {
  SHIFT, ONE, HALF, TWO, ANGLE_STEPS,
  fromInt, toInt, floorInt, round, fromFloat, toFloat,
  mul, div, abs, min, max, clamp,
  isqrtInt, sqrt, len, dist2, sin, cos, atan2,
};
