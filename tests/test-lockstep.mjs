/* =============================================================================
 * LOCKSTEP INTEGRATION TEST (§6)
 * Two independent "clients", each running its OWN sim state, exchange ONLY
 * inputs through an in-memory bus. After a full match they must hold identical
 * state hashes and no desync callback may fire — the headless stand-in for the
 * Safari<->Chrome match the design targets. Run: node test-lockstep.mjs
 * ===========================================================================*/
import { loadDB } from "./load-db.mjs";
import { buildBalance } from "../sim/balance.js";
import { createState } from "../sim/core.js";
import { createLockstep } from "../net/lockstep.js";
import { hashState } from "../sim/hash.js";
import * as C from "../net/commands.js";
import fx from "../sim/fx.js";

const DB = loadDB();
const bal = buildBalance(DB);
const SIM_DT = fx.fromFloat(1 / 30);
const cfg = (seed) => ({
  seed, mode: "loop", gameMode: "competitive", economy: "shared", statusMode: "standard",
  players: [
    { corridorCount: 3, elements: ["fire", "ice", "nature"] },
    { corridorCount: 3, elements: ["fire", "ice", "nature"] },
  ],
});

// In-memory bus: delivers inputs/hashes to every subscribed client (incl. echo).
function makeBus() {
  const inputSubs = [], hashSubs = [];
  return {
    clientTransport(localPlayer) {
      return {
        sendInputs: (tick, cmds) => inputSubs.forEach(fn => fn(tick, localPlayer, cmds)),
        onInputs: (cb) => inputSubs.push(cb),
        sendHash: (tick, hash) => hashSubs.forEach(fn => fn(tick, localPlayer, hash)),
        onHash: (cb) => hashSubs.push(cb),
      };
    },
  };
}

const SEED = 4242;
let desync = false;
function makeClient(localPlayer, bus) {
  const state = createState(bal, cfg(SEED));
  const transport = bus.clientTransport(localPlayer);
  const ls = createLockstep({
    state, SIM_DT, transport, localPlayer, playerCount: 2,
    onDesync: () => { desync = true; },
  });
  return { state, ls, localPlayer };
}

const bus = makeBus();
const c0 = makeClient(0, bus);
const c1 = makeClient(1, bus);
c0.ls.start();
c1.ls.start();

// Local actions keyed to the tick being PRODUCED (input-delayed). Same script
// for both players so each builds a symmetric defence; player 0 also sends.
function localCommands(player, producedTick) {
  const out = [];
  if (producedTick === 5)  out.push(C.buildTower(player, 0, 13, 30, "fire_0", 5));
  if (producedTick === 11) out.push(C.buildTower(player, 0, 18, 24, "fire_1", 5));
  if (producedTick === 17) out.push(C.buildTower(player, 1, 13, 40, "ice_0", 5));
  if (producedTick === 25) out.push(C.startWave(player));
  if (producedTick === 220 && player === 0) out.push(C.sendEnemy(0, 1, "runner"));
  if (producedTick === 720) out.push(C.startWave(player));
  return out;
}

// Fixed-rate loop: each frame every client produces ONE local input then
// advances ONE tick (models a real-time 30Hz step).
for (let frame = 0; frame < 2400; frame++) {
  c0.ls.produce(localCommands(0, c0.ls.tickLocal));
  c1.ls.produce(localCommands(1, c1.ls.tickLocal));
  c0.ls.advance(1);
  c1.ls.advance(1);
}

let pass = 0, fail = 0;
const ok = (n, cond) => { cond ? pass++ : (fail++, console.error("  FAIL:", n)); };

ok("no desync fired during the match", !desync);
ok("both clients advanced the same tick count", c0.state.tick === c1.state.tick);
ok("both clients reached identical final hash", hashState(c0.state) === hashState(c1.state));
ok("the match actually progressed", c0.state.tick > 1000);
ok("commands were applied (towers exist on both)",
   c0.state.players[0].corridors[0].towers.length > 0 &&
   c1.state.players[0].corridors[0].towers.length > 0);

console.log("\nlockstep: " + pass + " passed, " + fail + " failed");
const h0 = hashState(c0.state).toString(16);
const h1 = hashState(c1.state).toString(16);
console.log("  tick=" + c0.state.tick + "  hash0=" + h0 + "  hash1=" + h1 + "  p0towers=" + c0.state.players[0].corridors[0].towers.length);
process.exit(fail ? 1 : 0);
