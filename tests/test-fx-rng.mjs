/* Foundation tests: fixed-point math, RNG determinism, hashing. Run: node test-fx-rng.mjs */
import fx from "../sim/fx.js";
import rng from "../sim/rng.js";
import { hashState } from "../sim/hash.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };
const approx = (a, b, eps) => Math.abs(a - b) <= eps;

// ---- fixed-point arithmetic ----
ok("ONE round-trips", fx.toFloat(fx.fromFloat(1)) === 1);
ok("mul 2*3=6", fx.toFloat(fx.mul(fx.fromInt(2), fx.fromInt(3))) === 6);
ok("div 6/2=3", fx.toFloat(fx.div(fx.fromInt(6), fx.fromInt(2))) === 3);
ok("mul fractional 1.5*1.5=2.25", approx(fx.toFloat(fx.mul(fx.fromFloat(1.5), fx.fromFloat(1.5))), 2.25, 1e-4));

// ---- isqrt / sqrt ----
ok("isqrtInt(144)=12", fx.isqrtInt(144) === 12);
ok("isqrtInt(145)=12", fx.isqrtInt(145) === 12);
ok("isqrtInt(0)=0", fx.isqrtInt(0) === 0);
ok("sqrt(4)=2", approx(fx.toFloat(fx.sqrt(fx.fromInt(4))), 2, 1e-3));
ok("sqrt(2)~1.414", approx(fx.toFloat(fx.sqrt(fx.fromInt(2))), Math.SQRT2, 1e-3));
// len vs hypot
ok("len(3,4)=5", approx(fx.toFloat(fx.len(fx.fromInt(3), fx.fromInt(4))), 5, 1e-3));

// ---- trig LUT ----
ok("sin(0)=0", fx.sin(0) === 0);
ok("cos(0)=1", approx(fx.toFloat(fx.cos(0)), 1, 1e-3));
ok("sin(90deg)~1", approx(fx.toFloat(fx.sin(fx.ANGLE_STEPS / 4)), 1, 1e-3));
// atan2 quadrants
ok("atan2(0,+)=0", fx.atan2(0, fx.fromInt(1)) === 0);
ok("atan2(+,0)~90deg", approx(fx.atan2(fx.fromInt(1), 0) / fx.ANGLE_STEPS, 0.25, 0.02));
ok("atan2(0,-)~180deg", approx(fx.atan2(0, fx.fromInt(-1)) / fx.ANGLE_STEPS, 0.5, 0.02));

// ---- RNG determinism: same seed => same sequence ----
const a = rng.makeStream(12345), b = rng.makeStream(12345);
let same = true;
for (let i = 0; i < 10000; i++) if (rng.nextU32(a) !== rng.nextU32(b)) { same = false; break; }
ok("RNG same seed identical 10k draws", same);

// different seeds diverge
const c = rng.makeStream(1), d = rng.makeStream(2);
ok("RNG different seeds differ", rng.nextU32(c) !== rng.nextU32(d));

// distribution sanity for nextInt
const buckets = new Array(6).fill(0);
const e = rng.makeStream(99);
for (let i = 0; i < 60000; i++) buckets[rng.nextInt(e, 6)]++;
ok("nextInt(6) roughly uniform", buckets.every(x => x > 8000 && x < 12000));

// stream resumes from serialized s
const f = rng.makeStream(777);
for (let i = 0; i < 50; i++) rng.nextU32(f);
const saved = f.s;
const g = { s: saved };
ok("RNG resumes from serialized state", rng.nextU32(f) === rng.nextU32(g));

// ---- hash sanity (mini fake state) ----
const fake = {
  tick: 5, seedSim: { s: 42 }, elementOrder: ["fire", "ice"],
  players: [{ lives: 20, gold: 100, income: 0, wave: 3, alive: true, essence: { fire: 10, ice: 5 },
    corridors: [{ spawnedTotal: 4, towers: [{ cx: 1, cy: 2, level: 3, expert: 1, kills: 9, cd: 0 }] }] }],
  enemies: [{ id: 1, fx: 100, fy: 200, hp: 50, owner: 0, corridorIndex: 0, loopCount: 1 }],
  projectiles: [],
};
const h1 = hashState(fake);
const h2 = hashState(JSON.parse(JSON.stringify(fake)));
ok("hashState stable for identical state", h1 === h2);
fake.enemies[0].hp = 49;
ok("hashState changes when state changes", hashState(fake) !== h1);

console.log(`\nfx/rng/hash: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
