/* =============================================================================
 * Circle Tower Wars — net/lockstep.js
 * SYNCHRONOUS LOCKSTEP NETCODE (Decision D6, §6).
 *
 * Only INPUTS cross the network. One shared simulation runs identically on
 * every client. This module owns the input buffer, the input-delay scheduling,
 * the "waiting for player" stall, and periodic state-hash checkpoints (§6.4).
 *
 * Model: the local player PRODUCES exactly one input packet per tick, in order,
 * scheduled INPUT_DELAY ticks ahead of the tick currently being simulated. The
 * sim ADVANCES a tick only once inputs from ALL players for that tick are in.
 * Production (driven by the fixed-rate loop) leads consumption by INPUT_DELAY,
 * which hides network jitter. Empty input = an Ack heartbeat.
 *
 * Transport-agnostic: pass a `transport` exposing
 *   sendInputs(tick, commands), onInputs(cb), sendHash(tick, hash), onHash(cb)
 * (net/lobby.js wires this to Firebase RTDB). The sim itself stays pure.
 * ===========================================================================*/

import { orderCommands } from "./commands.js";
import { step } from "../sim/core.js";
import { hashState } from "../sim/hash.js";

export const INPUT_DELAY = 10;    // ticks (~330ms @30Hz) — covers RTDB round-trip so the sim never starves
export const HASH_EVERY = 30;     // checkpoint cadence (§6.4)
export const STALL_AFTER = 30;    // ticks of silence before pausing (§6.5)

export function createLockstep(opts) {
  const state = opts.state, SIM_DT = opts.SIM_DT, transport = opts.transport;
  const localPlayer = opts.localPlayer, playerCount = opts.playerCount;
  const onDesync = opts.onDesync, onStall = opts.onStall, onResume = opts.onResume;
  const onStep = opts.onStep; // (state) called after each executed sim tick (shell hook)

  const inputBuffer = new Map();  // tick -> { player -> commands[] }
  const myHashes = new Map();
  const peerHashes = new Map();
  let simTick = 0;                // next tick to execute
  let tickLocal = 0;              // next tick we owe local input for
  let stalled = false;
  let stallCount = 0;
  let seqCounter = 0;

  function ensure(tick) {
    let slot = inputBuffer.get(tick);
    if (!slot) { slot = {}; inputBuffer.set(tick, slot); }
    return slot;
  }
  function ackFor(p) { return [{ type: "Ack", player: p }]; }

  // Seed the first INPUT_DELAY ticks with local Acks, so tick 0 can run once all
  // clients have done the same. Call AFTER everyone has subscribed.
  function start() {
    for (let t = 0; t < INPUT_DELAY; t++) {
      const slot = ensure(t);
      if (!slot[localPlayer]) { slot[localPlayer] = ackFor(localPlayer); transport.sendInputs(t, slot[localPlayer]); }
    }
    tickLocal = INPUT_DELAY;
  }

  // Produce local input for the next owed tick (called once per fixed step by
  // the loop). `commands` = local actions gathered this step (may be empty).
  function produce(commands) {
    const tick = tickLocal++;
    let payload;
    if (commands && commands.length) {
      payload = commands.map(function (c) {
        const o = Object.assign({}, c); o.player = localPlayer; o.seq = seqCounter++; return o;
      });
    } else {
      payload = ackFor(localPlayer);
    }
    const slot = ensure(tick);
    slot[localPlayer] = payload;
    transport.sendInputs(tick, payload);
    return tick;
  }

  function haveAllInputsFor(tick) {
    const slot = inputBuffer.get(tick);
    if (!slot) return false;
    for (let p = 0; p < playerCount; p++) if (!slot[p]) return false;
    return true;
  }
  function missingPlayers(tick) {
    const slot = inputBuffer.get(tick) || {};
    const out = [];
    for (let p = 0; p < playerCount; p++) if (!slot[p]) out.push(p);
    return out;
  }

  // Execute up to maxTicks ready ticks (the loop caps this to the real-time rate).
  function advance(maxTicks) {
    maxTicks = maxTicks || 8;
    let executed = 0;
    while (executed < maxTicks && haveAllInputsFor(simTick)) {
      const slot = inputBuffer.get(simTick) || {};
      const all = [];
      for (let p = 0; p < playerCount; p++) if (slot[p]) for (let i = 0; i < slot[p].length; i++) all.push(slot[p][i]);
      step(state, orderCommands(all), SIM_DT);
      if (onStep) onStep(state);
      if (state.tick % HASH_EVERY === 0) {
        const h = hashState(state);
        myHashes.set(state.tick, h);
        transport.sendHash(state.tick, h);
        compareHashes(state.tick);
      }
      inputBuffer.delete(simTick);
      simTick++; executed++;
      stallCount = 0;
      if (stalled) { stalled = false; if (onResume) onResume(); }
    }
    if (executed === 0 && !haveAllInputsFor(simTick)) {
      // only surface the banner after a SUSTAINED stall (ignore transient jitter)
      stallCount++;
      if (stallCount >= STALL_AFTER && !stalled) { stalled = true; if (onStall) onStall(missingPlayers(simTick)); }
    }
    return executed;
  }

  function receiveInputs(tick, player, commands) {
    const slot = ensure(tick);
    slot[player] = (commands && commands.length) ? commands : ackFor(player);
  }
  function receiveHash(tick, player, hash) {
    let m = peerHashes.get(tick);
    if (!m) { m = {}; peerHashes.set(tick, m); }
    m[player] = hash;
    compareHashes(tick);
  }
  function compareHashes(tick) {
    const mine = myHashes.get(tick);
    const peers = peerHashes.get(tick);
    if (mine == null || !peers) return;
    for (const p in peers) {
      if (peers[p] !== mine) { if (onDesync) onDesync({ tick: tick, mine: mine, theirs: peers[p], player: +p }); return; }
    }
  }

  if (transport.onInputs) transport.onInputs(function (tick, player, commands) { receiveInputs(tick, player, commands); });
  if (transport.onHash) transport.onHash(function (tick, player, hash) { receiveHash(tick, player, hash); });

  const api = {
    start: start, produce: produce, advance: advance,
    receiveInputs: receiveInputs, receiveHash: receiveHash, INPUT_DELAY: INPUT_DELAY,
  };
  Object.defineProperty(api, "simTick", { get: function () { return simTick; } });
  Object.defineProperty(api, "tickLocal", { get: function () { return tickLocal; } });
  Object.defineProperty(api, "stalled", { get: function () { return stalled; } });
  return api;
}

export default { createLockstep, INPUT_DELAY, HASH_EVERY, STALL_AFTER };
