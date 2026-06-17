/* =============================================================================
 * Circle Tower Wars — net/lockstep.js
 * TURN-BASED LOCKSTEP NETCODE (Decision D6, §6).
 *
 * Only INPUTS cross the network. One shared simulation runs identically on
 * every client. To keep network traffic low (Firebase RTDB), inputs are
 * exchanged once per TURN, not once per sim tick: a TURN = TURN_TICKS sim ticks.
 * Commands collected during play are committed to a FUTURE turn (INPUT_DELAY
 * turns ahead) and applied at that turn's first tick. The TURN_TICKS-1 ticks in
 * between run locally with no network wait, so motion stays smooth at 30 Hz.
 *
 * Net rate = SIM_HZ / TURN_TICKS turns/sec (e.g. 30/15 = 2 packets/sec/player).
 * An empty turn is just an empty packet (the decoupled "Ack" — one tiny write
 * per turn instead of one per tick). State hashes are sent sparsely and old
 * keys are pruned so the RTDB node stays small.
 *
 * Transport (net/firebase.js) exposes:
 *   sendInputs(turn, commands), onInputs(cb), sendHash(turn, hash), onHash(cb),
 *   pruneInputs?(beforeTurn)  // optional cleanup of consumed keys
 * The sim itself stays pure.
 * ===========================================================================*/

import { orderCommands } from "./commands.js";
import { step } from "../sim/core.js";
import { hashState } from "../sim/hash.js";

export const TURN_TICKS = 15;        // 15 ticks/turn @30Hz -> 2 turns/sec
export const INPUT_DELAY = 1;        // turns of lookahead (~0.5s) — hides latency
export const HASH_EVERY_TURNS = 8;   // checkpoint every ~4s
export const STALL_AFTER = 20;       // advance() calls stuck before showing banner
export const KEEP_TURNS = 12;        // keep this many recent turns before pruning

export function createLockstep(opts) {
  const state = opts.state, SIM_DT = opts.SIM_DT, transport = opts.transport;
  const localPlayer = opts.localPlayer, playerCount = opts.playerCount;
  const onStep = opts.onStep, onDesync = opts.onDesync, onStall = opts.onStall, onResume = opts.onResume;
  const maxTicks = opts.maxTicks || 60;

  const turnInputs = new Map();   // turn -> { player -> commands[] }
  const myHashes = new Map();
  const peerHashes = new Map();
  let simTick = 0;                // next tick to execute
  let localTurn = 0;              // next turn we owe local input for
  let pending = [];               // local commands waiting for their turn
  let stalled = false;
  let stallCount = 0;
  let seqCounter = 0;

  function ensure(turn) {
    let slot = turnInputs.get(turn);
    if (!slot) { slot = {}; turnInputs.set(turn, slot); }
    return slot;
  }
  function haveTurn(turn) {
    const slot = turnInputs.get(turn);
    if (!slot) return false;
    for (let p = 0; p < playerCount; p++) if (!slot[p]) return false;
    return true;
  }
  function missingPlayers(turn) {
    const slot = turnInputs.get(turn) || {};
    const out = [];
    for (let p = 0; p < playerCount; p++) if (!slot[p]) out.push(p);
    return out;
  }

  // Commit local input for a specific turn and broadcast it.
  function emitTurn(turn, commands) {
    let payload;
    if (commands && commands.length) {
      payload = commands.map(function (c) { const o = Object.assign({}, c); o.player = localPlayer; o.seq = seqCounter++; return o; });
    } else {
      payload = []; // empty turn = decoupled heartbeat
    }
    ensure(turn)[localPlayer] = payload.length ? payload : [{ type: "Ack", player: localPlayer }];
    transport.sendInputs(turn, payload);
  }

  // Seed the first INPUT_DELAY turns so turn 0 can run once peers do the same.
  function start() {
    for (let t = 0; t < INPUT_DELAY; t++) emitTurn(t, []);
    localTurn = INPUT_DELAY;
  }

  // Queue a local command; it will be committed to the next produced turn.
  function queueLocal(commands) { for (let i = 0; i < commands.length; i++) pending.push(commands[i]); }

  // Called once per loop frame: keep producing turns so we stay INPUT_DELAY
  // ahead of the turn currently being simulated, then run ready ticks.
  function tickFrame() {
    const target = Math.floor(simTick / TURN_TICKS) + INPUT_DELAY;
    while (localTurn <= target) {
      emitTurn(localTurn, pending);
      pending = [];
      localTurn++;
    }
    return advance();
  }

  function advance() {
    let executed = 0;
    while (executed < maxTicks) {
      const turn = Math.floor(simTick / TURN_TICKS);
      const boundary = (simTick % TURN_TICKS === 0);
      if (boundary && !haveTurn(turn)) break; // wait for everyone's turn input
      let cmds = [];
      if (boundary) {
        const slot = turnInputs.get(turn) || {};
        for (let p = 0; p < playerCount; p++) if (slot[p]) for (let i = 0; i < slot[p].length; i++) cmds.push(slot[p][i]);
        cmds = orderCommands(cmds);
      }
      step(state, cmds, SIM_DT);
      if (onStep) onStep(state);
      simTick++; executed++;
      stallCount = 0;
      if (stalled) { stalled = false; if (onResume) onResume(); }
      // sparse hash + prune at turn boundaries
      if (simTick % TURN_TICKS === 0) {
        const justFinished = turn;
        if (justFinished % HASH_EVERY_TURNS === 0) {
          const h = hashState(state);
          myHashes.set(justFinished, h);
          transport.sendHash(justFinished, h);
          compareHashes(justFinished);
        }
        const prune = justFinished - KEEP_TURNS;
        if (prune >= 0) {
          turnInputs.delete(prune);
          if (transport.pruneInputs) transport.pruneInputs(prune);
        }
      }
    }
    if (executed === 0) {
      const turn = Math.floor(simTick / TURN_TICKS);
      if (!haveTurn(turn)) { stallCount++; if (stallCount >= STALL_AFTER && !stalled) { stalled = true; if (onStall) onStall(missingPlayers(turn)); } }
    }
    return executed;
  }

  function receiveInputs(turn, player, commands) {
    ensure(turn)[player] = (commands && commands.length) ? commands : [{ type: "Ack", player: player }];
  }
  function receiveHash(turn, player, hash) {
    let m = peerHashes.get(turn); if (!m) { m = {}; peerHashes.set(turn, m); }
    m[player] = hash; compareHashes(turn);
  }
  function compareHashes(turn) {
    const mine = myHashes.get(turn), peers = peerHashes.get(turn);
    if (mine == null || !peers) return;
    for (const p in peers) { if (peers[p] !== mine) { if (onDesync) onDesync({ turn: turn, mine: mine, theirs: peers[p], player: +p }); return; } }
  }

  if (transport.onInputs) transport.onInputs(function (turn, player, commands) { receiveInputs(turn, player, commands); });
  if (transport.onHash) transport.onHash(function (turn, player, hash) { receiveHash(turn, player, hash); });

  const api = {
    start: start, queueLocal: queueLocal, tickFrame: tickFrame,
    receiveInputs: receiveInputs, receiveHash: receiveHash,
    TURN_TICKS: TURN_TICKS, INPUT_DELAY: INPUT_DELAY,
  };
  Object.defineProperty(api, "simTick", { get: function () { return simTick; } });
  Object.defineProperty(api, "currentTurn", { get: function () { return Math.floor(simTick / TURN_TICKS); } });
  Object.defineProperty(api, "stalled", { get: function () { return stalled; } });
  return api;
}

export default { createLockstep, TURN_TICKS, INPUT_DELAY, HASH_EVERY_TURNS, STALL_AFTER, KEEP_TURNS };
