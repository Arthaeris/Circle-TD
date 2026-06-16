/* =============================================================================
 * DETERMINISM PROPERTY TEST (§6.4 / §11)
 * Proves the core invariant lockstep relies on:
 *   same seed + same command stream  =>  identical state hash at every tick.
 * Runs two independent simulations of a 2-player competitive match and compares
 * their hash timelines; then runs a third with a different seed and asserts it
 * diverges. Run: node test-determinism.mjs
 * ===========================================================================*/
import { loadDB } from "./load-db.mjs";
import { buildBalance } from "../sim/balance.js";
import { createState, step } from "../sim/core.js";
import { hashState } from "../sim/hash.js";
import fx from "../sim/fx.js";

const DB = loadDB();
const bal = buildBalance(DB);
const SIM_DT = fx.fromFloat(1 / 30);

function makeCfg(seed) {
  return {
    seed, mode: "loop", gameMode: "competitive", economy: "shared", statusMode: "standard",
    players: [
      { corridorCount: 4, elements: ["fire", "ice", "nature", "storm"] },
      { corridorCount: 4, elements: ["fire", "ice", "nature", "storm"] },
    ],
  };
}

// A fixed, scripted command timeline (same for every run). Tile coords chosen
// near the central seam so placements are valid. Issued at specific ticks.
function commandsForTick(tick) {
  const cmds = [];
  const place = (player, corridorId, gx, gy, towerType) =>
    cmds.push({ type: "BuildTower", player, corridorId, gx, gy, towerType, masteryLevel: 5 });

  // Portal columns are 15/16/17, so place towers flanking the path (col ~15).
  if (tick === 5)  { place(0, 0, 13, 30, "fire_0"); place(1, 0, 13, 30, "fire_0"); }
  if (tick === 10) { place(0, 0, 18, 22, "fire_1"); place(1, 0, 18, 22, "ice_1"); }
  if (tick === 15) { place(0, 1, 13, 40, "ice_0");  place(1, 1, 13, 40, "nature_0"); }
  if (tick === 20) { cmds.push({ type: "StartWave", player: 0 }); cmds.push({ type: "StartWave", player: 1 }); }
  if (tick === 200) cmds.push({ type: "SendEnemy", player: 0, target: 1, enemyType: "runner" });
  if (tick === 240) cmds.push({ type: "SendEnemy", player: 0, target: 1, enemyType: "brute" });
  if (tick === 300) { cmds.push({ type: "UpgradeTower", player: 0, corridorId: 0, towerId: findFirstTowerId(0) }); }
  if (tick === 600) cmds.push({ type: "StartWave", player: 0 });
  if (tick === 650) cmds.push({ type: "StartWave", player: 1 });
  return cmds;
}
// (UpgradeTower needs a tower id; resolved against run A and reused so both runs
// get identical command objects — see runSim where we snapshot ids.)
let _firstTowerId = { 0: 1 };
function findFirstTowerId(player) { return _firstTowerId[player] || 1; }

function runSim(seed, captureTowerIds) {
  const state = createState(bal, makeCfg(seed));
  const hashes = [];
  for (let tick = 1; tick <= 1800; tick++) {
    if (captureTowerIds && tick === 6) {
      const t = state.players[0].corridors[0].towers[0];
      if (t) _firstTowerId[0] = t.id;
    }
    step(state, commandsForTick(tick), SIM_DT);
    if (tick % 30 === 0) hashes.push(hashState(state));
  }
  return { hashes, state };
}

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error("  FAIL:", n)); };

// Run A first to capture the dynamic tower id, then A2 with the same script.
const A = runSim(777, true);
const A2 = runSim(777, false);

ok("two identical runs produce identical hash count", A.hashes.length === A2.hashes.length);
let allSame = true, firstDiff = -1;
for (let i = 0; i < A.hashes.length; i++) if (A.hashes[i] !== A2.hashes[i]) { allSame = false; firstDiff = i; break; }
ok("identical seed+commands => identical hash at every checkpoint", allSame);
if (!allSame) console.error("    first divergence at checkpoint", firstDiff, A.hashes[firstDiff], "vs", A2.hashes[firstDiff]);

// Different seed should diverge somewhere (obstacle layout + RNG differ).
const B = runSim(778, false);
let diverged = false;
for (let i = 0; i < A.hashes.length; i++) if (A.hashes[i] !== B.hashes[i]) { diverged = true; break; }
ok("different seed => divergent timeline", diverged);

// The sim actually did something (enemies spawned, kills happened, gold moved).
ok("simulation advanced tick count", A.state.tick === 1800);
ok("players took actions (towers built)", A.state.players[0].corridors[0].towers.length > 0);
ok("waves were generated", A.state.players[0].wave >= 1);
const totalKills = A.state.players.reduce((s, p) => s + p.stats.kills, 0);
ok("enemies were killed", totalKills > 0);

console.log("\ndeterminism: " + pass + " passed, " + fail + " failed");
const fh = A.hashes[A.hashes.length - 1].toString(16);
const p0 = A.state.players[0], p1 = A.state.players[1];
console.log("  final hash A=" + fh + "  kills=" + totalKills + "  p0 gold=" + p0.gold + " lives=" + p0.lives + "  p1 lives=" + p1.lives);
process.exit(fail ? 1 : 0);
