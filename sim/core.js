/* =============================================================================
 * Circle Tower Wars — sim/core.js
 * THE PURE DETERMINISTIC SIMULATION CORE (Decisions D6/D7/D9/D10, §2/§3/§6/§7/§8).
 *
 * HARD ARCHITECTURE BOUNDARY (§2/§7): this file contains NO
 *   document, no canvas, no requestAnimationFrame, no Math.random,
 *   no Date.now / performance.now, no audio.
 * It holds the COMPLETE state of ALL players' fields and advances it with a
 * single function:  step(state, commands, SIM_DT)  ->  mutates state in place.
 *
 * Inputs over the wire are COMMANDS only (§6.1) — intent, never results.
 * Validation (enough gold? tile free?) happens here, identically on every
 * client. All state-changing maths run in fixed-point (sim/fx.js); all random
 * draws come from the seeded SIM stream (sim/rng.js). Iteration is always over
 * arrays in stable order (§3 rule 4) so the state hash matches across engines.
 *
 * The shell (render/ui/net/app) reads `state` to draw and produces commands;
 * it must never mutate `state` directly.
 * ===========================================================================*/

import * as fx from "./fx.js";
import * as rng from "./rng.js";
import * as pf from "./pathfind.js";
import { generateWave, enemyScale, totalWaves, waveAffix } from "./waves.js";

const F = fx.fromFloat;
const HALF = fx.HALF;                  // 0.5 in fixed
export const SIM_HZ = 30;

// Grid cell codes (see pathfind.js): 0 free, 1 obstacle, 2 tower.
const CELL_FREE = 0, CELL_OBSTACLE = 1, CELL_TOWER = 2;

// ---------------------------------------------------------------------------
// STATE CONSTRUCTION
// ---------------------------------------------------------------------------
/**
 * cfg: {
 *   seed, mode ("single"|"loop"|"endless"), gameMode ("solo"|"coop"|"competitive"),
 *   economy ("shared"|"elemental"), statusMode ("standard"|"advanced"),
 *   players: [ { corridorCount, elements:[elementId,...] } ]
 * }
 */
export function createState(bal, cfg) {
  const seed = (cfg.seed >>> 0) || 1;
  const state = {
    bal,                                  // balancing data (not hashed)
    tick: 0,
    seedSim: rng.makeStream(seed),        // hashed (drives all state randomness)
    seedBase: seed,
    mode: cfg.mode || "loop",
    gameMode: cfg.gameMode || "solo",
    economy: cfg.economy || "shared",
    statusMode: cfg.statusMode || "standard",
    elementOrder: bal.elementOrder.slice(),
    grid: { cols: bal.grid.cols, rows: bal.grid.rows },
    players: [],
    enemies: [],
    projectiles: [],
    nextId: 1,
    coopLives: 0,
    netSpeed: 1,                          // synced sim-speed multiplier (host-controlled in MP)
    finished: false,
    events: [],                           // transient, shell-facing, cleared each step
  };

  const G = state.grid;
  const portalC = Math.floor(bal.portalCols[0]);

  (cfg.players || [{ corridorCount: 1, elements: ["fire"] }]).forEach((pc, pi) => {
    const player = {
      id: pi,
      lives: bal.startLives,
      maxLives: bal.startLives,
      gold: bal.startGold,
      essence: {},
      income: 0,                          // §8.1 passive income (competitive)
      incomeTick: 0,
      sentCount: 0,                        // total enemies sent (for rising cost §8.3)
      wave: 0,
      totalWaves: totalWaves(cfg.mode, pc.corridorCount),
      phase: "build",                      // build | wave | prep | endboss | victory | defeat
      alive: true,
      waveActive: false,
      spawnQueue: [],
      corridorCount: pc.corridorCount,
      elements: pc.elements.slice(),
      corridors: [],
      endBossId: 0,
      stats: { kills: 0, bossesKilled: 0, score: 0 },
    };
    for (const e of bal.elementOrder) player.essence[e] = bal.startEssence;

    const buildField = !((cfg.gameMode === "coop") && pi > 0); // co-op: one shared field on player 0
    for (let i = 0; buildField && i < pc.corridorCount; i++) {
      const grid = pf.makeGrid(G.cols, G.rows);
      const corr = {
        index: i,
        element: pc.elements[i % pc.elements.length],
        grid,
        dist: new Int32Array(G.cols * G.rows),
        entrance: { c: portalC, r: G.rows - 1 },
        exit: { c: portalC, r: 0 },
        towers: [],
        spawnedTotal: 0,
      };
      seedObstacles(state, corr, pi, i);
      pf.computeFlow(corr, G.cols, G.rows);
      player.corridors.push(corr);
    }
    state.players.push(player);
  });

  state.coopLives = bal.startLives * (state.gameMode === "coop" ? state.players.length : 1);
  return state;
}

// Deterministic obstacle seeding using the SIM rng (so it is identical across
// clients and reproducible from the seed alone).
function seedObstacles(state, corr, playerIdx, corrIdx) {
  const G = state.grid;
  // dedicated sub-stream derived from base seed + indices (still deterministic)
  const local = rng.makeStream((state.seedBase * 97 + playerIdx * 911 + corrIdx * 31 + 7) >>> 0);
  const dens = state.bal.obstacleDensity; // fixed [0,ONE]
  for (let r = 2; r < G.rows - 2; r++) {
    for (let c = 0; c < G.cols; c++) {
      if (rng.nextFixed(local) < dens) {
        if (c === 6 && (r < 3 || r > G.rows - 4)) continue; // keep a seam
        corr.grid[r * G.cols + c] = CELL_OBSTACLE;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// THE STEP — advances the whole simulation by one fixed tick.
// commands: array already ordered deterministically (by player, then sequence).
// SIM_DT: fixed-point seconds (e.g. fx.fromFloat(1/30)).
// ---------------------------------------------------------------------------
export function step(state, commands, SIM_DT) {
  state.events.length = 0;
  state.tick++;

  // 1) Apply player commands (validated in-core, identical on all clients).
  if (commands && commands.length) {
    for (let i = 0; i < commands.length; i++) applyCommand(state, commands[i]);
  }

  // 2) Spawn queued enemies whose time has come.
  updateSpawns(state);

  // 3) Towers acquire targets and fire (per player, per corridor, stable order).
  for (let pi = 0; pi < state.players.length; pi++) {
    const pl = state.players[pi];
    if (!pl.alive) continue;
    for (let ci = 0; ci < pl.corridors.length; ci++) updateTowers(state, pl, pl.corridors[ci], SIM_DT);
  }

  // 4) Projectiles travel and impact.
  updateProjectiles(state, SIM_DT);

  // 5) Enemies: statuses, movement, transitions, loops, lives.
  updateEnemies(state, SIM_DT);

  // 6) Passive income (competitive §8.1) + catch-up (§8.3).
  updateIncome(state);

  // 7) Wave completion / phase transitions.
  for (let pi = 0; pi < state.players.length; pi++) checkWaveState(state, state.players[pi]);

  return state;
}

// ---------------------------------------------------------------------------
// COMMANDS (§6.1)
// ---------------------------------------------------------------------------
function applyCommand(state, cmd) {
  const pl = state.players[cmd.player];
  if (!pl || !pl.alive) return;
  switch (cmd.type) {
    case "BuildTower":   cmdBuild(state, pl, cmd); break;
    case "SellTower":    cmdSell(state, pl, cmd); break;
    case "UpgradeTower": cmdUpgrade(state, pl, cmd); break;
    case "MutateTower":  cmdMutate(state, pl, cmd); break;
    case "StartWave":    cmdStartWave(state, pl, cmd); break;
    case "SendEnemy":    cmdSendEnemy(state, pl, cmd); break;
    case "SetTargetMode": cmdSetTargetMode(state, pl, cmd); break;
    case "SetSpeed":     if (cmd.player === 0) { const sp = cmd.speed | 0; state.netSpeed = sp < 1 ? 1 : (sp > 3 ? 3 : sp); } break;
    case "Ack":          break; // heartbeat, no state change
  }
}

function fieldOwner(state, pl) { return state.gameMode === "coop" ? state.players[0] : pl; }
function essenceOf(pl, element) { return pl.essence[element] | 0; }
function canAfford(state, pl, amount, element) {
  return state.economy === "shared" ? pl.gold >= amount : essenceOf(pl, element) >= amount;
}
function spend(state, pl, amount, element) {
  if (state.economy === "shared") pl.gold -= amount; else pl.essence[element] -= amount;
}
function grant(state, pl, amount, element) {
  if (state.economy === "shared") pl.gold += amount; else pl.essence[element] += amount;
}

function upgradeCost(state, def, level) {
  // round(cost * upgradeCostBase * costGrowth^(level-1)) — done in fixed, then to int
  const base = fx.mul(fx.fromInt(def.cost), state.bal.scaling.upgradeCostBase);
  let growth = fx.ONE;
  for (let l = 1; l < level; l++) growth = fx.mul(growth, state.bal.scaling.costGrowth);
  return fx.round(fx.mul(base, growth));
}
function totalInvested(state, tw) {
  let c = tw.def.cost;
  for (let l = 1; l < tw.level; l++) c += upgradeCost(state, tw.def, l);
  return c;
}

function cmdBuild(state, pl, cmd) {
  const corr = fieldOwner(state, pl).corridors[cmd.corridorId];
  if (!corr) return;
  const def = state.bal.towers[cmd.towerType];
  if (!def) return;
  if (def.slot >= unlockedTowerSlots(cmd.masteryLevel || 5)) return;
  if (!canAfford(state, pl, def.cost, def.element)) { state.events.push({ kind: "reject", player: pl.id, reason: "funds" }); return; }
  const spot = findValidSpot(state, corr, cmd.gx, cmd.gy);
  if (!spot) { state.events.push({ kind: "reject", player: pl.id, reason: "noRoom" }); return; }
  placeTower(state, corr, def, spot.c, spot.r, pl.id);
  spend(state, pl, def.cost, def.element);
}

function cmdSell(state, pl, cmd) {
  const corr = fieldOwner(state, pl).corridors[cmd.corridorId]; if (!corr) return;
  const ti = corr.towers.findIndex(t => t.id === cmd.towerId); if (ti < 0) return;
  const tw = corr.towers[ti];
  const S = state.bal.towerSize, G = state.grid;
  for (let rr = tw.r; rr < tw.r + S; rr++) for (let cc = tw.c; cc < tw.c + S; cc++) corr.grid[rr * G.cols + cc] = CELL_FREE;
  corr.towers.splice(ti, 1);
  grant(state, pl, fx.round(fx.mul(fx.fromInt(totalInvested(state, tw)), state.bal.sellRefund)), tw.def.element);
  pf.computeFlow(corr, G.cols, G.rows);
}

function cmdUpgrade(state, pl, cmd) {
  const corr = fieldOwner(state, pl).corridors[cmd.corridorId]; if (!corr) return;
  const tw = corr.towers.find(t => t.id === cmd.towerId); if (!tw) return;
  if (tw.level >= state.bal.maxLevel) return;
  const cost = upgradeCost(state, tw.def, tw.level);
  if (!canAfford(state, pl, cost, tw.def.element)) { state.events.push({ kind: "reject", player: pl.id, reason: "funds" }); return; }
  spend(state, pl, cost, tw.def.element);
  tw.level++;
}

function cmdMutate(state, pl, cmd) {
  const corr = fieldOwner(state, pl).corridors[cmd.corridorId]; if (!corr) return;
  const tw = corr.towers.find(t => t.id === cmd.towerId); if (!tw) return;
  if (tw.level < state.bal.maxLevel) { state.events.push({ kind: "reject", player: pl.id, reason: "needMax" }); return; }
  const slots = mutationSlotsAvailable(cmd.masteryLevel || 5);
  if (tw.mutations.length >= slots) { state.events.push({ kind: "reject", player: pl.id, reason: "noSlots" }); return; }
  if (tw.mutations.includes(cmd.mutId)) return;
  if (!tw.def.mutations.find(m => m.id === cmd.mutId)) return;
  tw.mutations.push(cmd.mutId);
}

// Per-tower targeting priority (display-independent, deterministic).
const TARGET_MODES = ["first", "last", "strong", "weak"];
function cmdSetTargetMode(state, pl, cmd) {
  const corr = fieldOwner(state, pl).corridors[cmd.corridorId]; if (!corr) return;
  const tw = corr.towers.find(t => t.id === cmd.towerId); if (!tw) return;
  if (!TARGET_MODES.includes(cmd.mode)) return;
  tw.targetMode = cmd.mode;
}

function cmdStartWave(state, pl, cmd) {
  const fp = fieldOwner(state, pl); // co-op: the single shared field
  if (fp.phase === "prep") { summonEndBoss(state, fp); return; }
  if (fp.phase === "victory" || fp.phase === "defeat" || fp.phase === "endboss") return;
  if (state.mode !== "endless" && fp.wave >= fp.totalWaves) return;
  // Early-call bonus: calling the next wave while the previous one is still
  // being fought pays out immediately (risk/reward for skilled play).
  if (fp.phase === "wave") {
    const ec = state.bal.earlyCall;
    const eb = ec.base + (fp.wave + 1) * ec.perWave;
    if (state.gameMode === "coop") { for (const p of state.players) grantAll(state, p, eb); }
    else grantAll(state, fp, eb);
    state.events.push({ kind: "earlyBonus", player: fp.id, bonus: eb });
  }
  fp.wave++;
  const affix = waveAffix(state.seedBase, fp.wave, state.bal.bossEvery);
  const entries = generateWave(fp.wave, fp.corridorCount, state.bal.bossEvery);
  let originRot = 0;
  for (const group of entries) {
    const count = (affix && affix.countMult) ? Math.max(1, Math.round(group.count * affix.countMult)) : group.count;
    for (let k = 0; k < count; k++) {
      const origin = group.type === "boss"
        ? rng.nextInt(state.seedSim, fp.corridorCount)
        : (originRot++ % fp.corridorCount);
      const atTick = state.tick + fx.toInt(fx.mul(group.delay + fx.mul(fx.fromInt(k), group.gap), fx.fromInt(SIM_HZ)));
      fp.spawnQueue.push({ type: group.type, origin, atTick, sent: false, wave: fp.wave });
      fp.corridors[origin].spawnedTotal++;
    }
  }
  fp.waveActive = true;
  fp.phase = "wave";
  state.events.push({ kind: "wave", player: fp.id, wave: fp.wave, boss: (fp.wave % state.bal.bossEvery === 0), affix: affix ? affix.id : null });
}

// Competitive: spend gold to spawn extra enemies on a target, builds income (§8).
function cmdSendEnemy(state, pl, cmd) {
  if (state.gameMode !== "competitive") return;
  const target = state.players[cmd.target];
  if (!target || !target.alive || target === pl) return;
  const comp = state.bal.competitive;
  // rising send cost (§8.3): base * growth^sentCount  (does NOT raise defender bounty)
  let cost = comp.sendBaseCost;
  let growth = fx.ONE;
  for (let i = 0; i < pl.sentCount; i++) growth = fx.mul(growth, comp.sendCostGrowth);
  cost = fx.round(fx.mul(fx.fromInt(comp.sendBaseCost), growth));
  if (!canAfford(state, pl, cost, pl.elements[0])) return;
  // cap on concurrent sent enemies per target (§8.3)
  let activeSent = 0;
  for (const e of state.enemies) if (e.owner === target.id && e.sent) activeSent++;
  if (activeSent >= comp.maxActiveSentPerTarget) return;

  spend(state, pl, cost, pl.elements[0]);
  pl.sentCount++;
  pl.income += comp.incomePerSend;          // §8.1 sending builds passive income
  const type = cmd.enemyType || "grunt";
  const origin = rng.nextInt(state.seedSim, target.corridorCount);
  spawnEnemy(state, target, type, origin, target.wave || 1, true);
  state.events.push({ kind: "sent", from: pl.id, to: target.id, type });
}

function unlockedTowerSlots(masteryLevel) {
  if (masteryLevel >= 4) return 5;
  if (masteryLevel >= 2) return 4;
  if (masteryLevel >= 1) return 3;
  return 2;
}
function mutationSlotsAvailable(masteryLevel) {
  if (masteryLevel >= 5) return 2;
  if (masteryLevel >= 3) return 1;
  return 0;
}

// Read-only query used by the shell to preview where a tower would actually be
// placed (mirrors cmdBuild). Self-reverting; safe to call between sim ticks.
export function findBuildSpot(state, player, corridorId, gx, gy) {
  const pl = state.players[player]; if (!pl) return null;
  const corr = pl.corridors[corridorId]; if (!corr) return null;
  return findValidSpot(state, corr, gx, gy);
}

// ---------------------------------------------------------------------------
// TOWER PLACEMENT
// ---------------------------------------------------------------------------
function validTowerArea(state, corr, c, r) {
  const G = state.grid, S = state.bal.towerSize;
  if (c < 0 || r < 0 || c + S > G.cols || r + S > G.rows) return false;
  for (let rr = r; rr < r + S; rr++) for (let cc = c; cc < c + S; cc++) {
    if (corr.grid[rr * G.cols + cc] !== CELL_FREE) return false;
    if (rr <= 1 && Math.abs(cc - corr.exit.c) <= 1) return false;
    if (rr >= G.rows - 2 && Math.abs(cc - corr.entrance.c) <= 1) return false;
  }
  // temporarily block, test reachability, revert
  for (let rr = r; rr < r + S; rr++) for (let cc = c; cc < c + S; cc++) corr.grid[rr * G.cols + cc] = CELL_TOWER;
  pf.computeFlow(corr, G.cols, G.rows);
  const ok = pf.reachable(corr, G.cols) && pathClear(state, corr);
  for (let rr = r; rr < r + S; rr++) for (let cc = c; cc < c + S; cc++) corr.grid[rr * G.cols + cc] = CELL_FREE;
  pf.computeFlow(corr, G.cols, G.rows);
  return ok;
}
function pathClear(state, corr) {
  const G = state.grid;
  for (const e of state.enemies) {
    if (e.corr !== corr) continue;
    const c = fx.clamp(fx.floorInt(e.fx), 0, G.cols - 1), r = fx.clamp(fx.floorInt(e.fy), 0, G.rows - 1);
    if (corr.dist[r * G.cols + c] >= pf.INF) return false;
  }
  return true;
}
function findValidSpot(state, corr, gx, gy) {
  const tl = (c, r) => validTowerArea(state, corr, c, r) ? { c, r } : null;
  let best = tl(gx - 1, gy - 1);
  if (best) return best;
  for (let rad = 1; rad <= 2; rad++)
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const s = tl(gx - 1 + dc, gy - 1 + dr);
      if (s) return s;
    }
  return null;
}
function placeTower(state, corr, def, c, r, owner) {
  const S = state.bal.towerSize, G = state.grid;
  const tw = {
    id: state.nextId++, def, c, r, owner: owner || 0,
    cx: fx.fromInt(c) + fx.fromInt(S) / 2,  // fixed-point centre (tiles)
    cy: fx.fromInt(r) + fx.fromInt(S) / 2,
    level: 1, expert: 0, kills: 0, mutations: [], cd: 0,
    ampBuff: fx.ONE, hasteBuff: fx.ONE, beamT: 0,
  };
  for (let rr = r; rr < r + S; rr++) for (let cc = c; cc < c + S; cc++) corr.grid[rr * G.cols + cc] = CELL_TOWER;
  corr.towers.push(tw);
  pf.computeFlow(corr, G.cols, G.rows);
  return tw;
}

// ---------------------------------------------------------------------------
// SPAWNING
// ---------------------------------------------------------------------------
function updateSpawns(state) {
  for (const pl of state.players) {
    if (!pl.spawnQueue.length) continue;
    const remaining = [];
    for (const s of pl.spawnQueue) {
      // spawn with the wave the enemy was queued FOR (matters when waves
      // overlap via early calls), falling back to the field's current wave
      if (state.tick >= s.atTick) spawnEnemy(state, pl, s.type, s.origin, s.wave || pl.wave, false);
      else remaining.push(s);
    }
    pl.spawnQueue = remaining;
  }
}

function spawnEnemy(state, pl, type, origin, wave, sent) {
  const def = state.bal.enemies[type]; if (!def) return;
  const sc = enemyScale(Math.max(1, wave));
  const corr = pl.corridors[origin];
  let maxHp = fx.mul(def.hp, sc.hp);
  let armor = def.armor, baseSpeed = def.speed;
  // wave affix (never on bosses or sent enemies; pure function of seed+wave)
  const affix = (!def.boss && !sent) ? waveAffix(state.seedBase, wave, state.bal.bossEvery) : null;
  if (affix) {
    if (affix.hpMult) maxHp = fx.mul(maxHp, F(affix.hpMult));
    if (affix.armorAdd) armor += fx.fromInt(affix.armorAdd);
    if (affix.speedMult) baseSpeed = fx.mul(baseSpeed, F(affix.speedMult));
  }
  const e = {
    id: state.nextId++, type, def,
    owner: pl.id, originIndex: origin, corridorIndex: origin, corr,
    fx: fx.fromInt(corr.entrance.c) + HALF,
    fy: fx.fromInt(corr.entrance.r) + HALF,
    maxHp, hp: maxHp,
    armor, baseSpeed,
    reward: Math.round(def.reward * (sc.reward / fx.ONE)),
    statuses: {}, statusKeys: [], buffs: 0,
    loopCount: 0, transitions: 0,
    alive: true, boss: def.boss, end: def.end,
    resist: {}, sent: !!sent,
    speedBuff: fx.ONE,
    affix: affix ? affix.id : null,
  };
  state.enemies.push(e);
}

// ---------------------------------------------------------------------------
// ENEMY UPDATE
// ---------------------------------------------------------------------------
function updateEnemies(state, dt) {
  const G = state.grid;
  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const e = state.enemies[i];
    if (!e.alive) continue;
    const pl = state.players[e.owner];
    const corr = e.corr;

    // statuses
    let moveMult = fx.ONE, dmgTakenMult = fx.ONE, stunned = false, dotDps = 0, shred = 0;
    for (let k = e.statusKeys.length - 1; k >= 0; k--) {
      const key = e.statusKeys[k];
      const st = e.statuses[key];
      st.remaining -= dt;
      if (st.remaining <= 0) { delete e.statuses[key]; e.statusKeys.splice(k, 1); continue; }
      const d = st.def;
      switch (d.kind) {
        case "dot": dotDps += fx.mul(st.value, st.dotMult || fx.ONE); break;
        case "slow": moveMult = fx.mul(moveMult, d.value); break;
        case "stun": stunned = true; break;
        case "amp": dmgTakenMult = fx.mul(dmgTakenMult, d.value); break;
        case "shred": shred += d.value; break;
        case "custom": stunned = handleCustom(state, e, st, dt, stunned); break;
      }
    }
    e.dmgTakenMult = dmgTakenMult;
    e.shred = shred;

    if (dotDps > 0) damageEnemy(state, e, fx.mul(dotDps, dt), null, true);
    if (!e.alive) { removeEnemy(state, e, i); continue; }

    if (!stunned) {
      // speed (tiles/sec, fixed) = baseSpeed * enemyBaseSpeed * moveMult * speedBuff
      let speed = fx.mul(e.baseSpeed, state.bal.enemyBaseSpeed);
      speed = fx.mul(speed, moveMult);
      speed = fx.mul(speed, e.speedBuff);
      moveAlongFlow(state, e, corr, fx.mul(speed, dt));
    }

    // reached exit?
    const tc = fx.clamp(fx.floorInt(e.fx), 0, G.cols - 1), tr = fx.clamp(fx.floorInt(e.fy), 0, G.rows - 1);
    if (tr <= corr.exit.r && Math.abs(tc - corr.exit.c) <= 1) transferEnemy(state, e);
  }
}

function moveAlongFlow(state, e, corr, stepFx) {
  const G = state.grid;
  let guard = 0;
  while (stepFx > 0 && guard++ < 8) {
    const c = fx.clamp(fx.floorInt(e.fx), 0, G.cols - 1), r = fx.clamp(fx.floorInt(e.fy), 0, G.rows - 1);
    const k = pf.bestNeighbor(corr, G.cols, G.rows, c, r);
    let tx, ty;
    if (k != null) { tx = fx.fromInt(c + pf.NB[k][0]) + HALF; ty = fx.fromInt(r + pf.NB[k][1]) + HALF; }
    else { tx = fx.fromInt(corr.exit.c) + HALF; ty = fx.fromInt(corr.exit.r) + HALF; }
    const dx = tx - e.fx, dy = ty - e.fy;
    let d = fx.len(dx, dy);
    if (d <= 0) d = 1;
    if (d <= stepFx) { e.fx = tx; e.fy = ty; stepFx -= d; }
    else {
      e.fx += fx.div(fx.mul(dx, stepFx), d);
      e.fy += fx.div(fx.mul(dy, stepFx), d);
      stepFx = 0;
    }
  }
}

function transferEnemy(state, e) {
  const pl = state.players[e.owner];
  const from = e.corridorIndex;
  const next = (from + 1) % pl.corridorCount;
  e.transitions++;
  e.corridorIndex = next;
  e.corr = pl.corridors[next];
  e.fx = fx.fromInt(e.corr.entrance.c) + HALF;
  e.fy = fx.fromInt(e.corr.entrance.r) + HALF;

  const cur = e.statuses["cursed"];
  if (cur) { damageEnemy(state, e, fx.mul(cur.value, cur.curseBoost || fx.ONE), null, true); if (!e.alive) return; }

  if (e.transitions % pl.corridorCount === 0) onLoopComplete(state, pl, e);
  if (state.statusMode === "advanced" && e.transitions % pl.corridorCount === 0) e.statusLocked = false;
}

function onLoopComplete(state, pl, e) {
  e.loopCount++;
  loseLife(state, pl, state.bal.loopLifeLoss);
  if (pl.lives <= 0) return;
  applyAdaptation(state, e);
  if (state.statusMode === "advanced") e.statusLocked = true;
}

function applyAdaptation(state, e) {
  const opts = ["speed", "health", "armor", "resist", "momentum", "hardened"];
  const pick = rng.pick(state.seedSim, opts);
  e.adapt = e.adapt || {}; e.adapt[pick] = (e.adapt[pick] || 0) + 1; // record for UI
  switch (pick) {
    case "speed": e.speedBuff = fx.mul(e.speedBuff, F(1.15)); break;
    case "health": e.maxHp = fx.mul(e.maxHp, F(1.25)); e.hp = fx.min(e.maxHp, e.hp + fx.mul(e.maxHp, F(0.25))); break;
    case "armor": e.armor += fx.fromInt(4); break;
    case "resist": {
      const el = state.players[e.owner].elements[e.originIndex];
      e.resist[el] = (e.resist[el] || 0) + F(0.2);
      break;
    }
    case "momentum": applyStatusRaw(state, e, "momentum"); break;
    case "hardened": applyStatusRaw(state, e, "hardened"); break;
  }
  if (e.loopCount >= 3) applyStatusRaw(state, e, "veteran");
  e.buffs++;
}

function handleCustom(state, e, st, dt, stunned) {
  const id = st.def.id;
  if (id === "shocked") {
    st.arcT = (st.arcT || 0) - dt;
    if (st.arcT <= 0) { st.arcT = F(0.6); arcToNeighbors(state, e, st.def.value); }
  } else if (id === "molten") {
    st.t = (st.t || 0) - dt;
    if (st.t <= 0) { st.t = F(0.4); aoeAround(state, e, F(1.2), fx.mul(st.def.value, F(0.4))); }
  } else if (id === "blinded") {
    st.cycle = (st.cycle || 0) + dt;
    // stop ~ first third of a 1.5s cycle
    if ((st.cycle % F(1.5)) < F(0.5)) stunned = true;
  } else if (id === "lifted" || id === "momentum") {
    // movement multiplier handled as slow-like in value (kept simple/deterministic)
  } else if (id === "entropy") {
    st.t = (st.t || 0) - dt;
    if (st.t <= 0) { st.t = F(2); applyStatusRaw(state, e, rng.pick(state.seedSim, ["burning", "poisoned", "chilled", "shocked", "weakened"])); }
  }
  return stunned;
}

function arcToNeighbors(state, e, dmg) {
  let hit = 0;
  const R2 = fx.mul(F(2.2), F(2.2));
  for (const o of state.enemies) {
    if (o === e || !o.alive || o.owner !== e.owner || o.corr !== e.corr) continue;
    if (fx.dist2(e.fx, e.fy, o.fx, o.fy) < R2) { damageEnemy(state, o, dmg, null, true); if (++hit >= 2) break; }
  }
}
function aoeAround(state, e, radius, dmg) {
  const R2 = fx.mul(radius, radius);
  for (const o of state.enemies) {
    if (o === e || !o.alive || o.owner !== e.owner || o.corr !== e.corr) continue;
    if (fx.dist2(e.fx, e.fy, o.fx, o.fy) < R2) damageEnemy(state, o, dmg, null, true);
  }
}

function removeEnemy(state, e, idxHint) {
  e.alive = false;
  const i = (idxHint != null && state.enemies[idxHint] === e) ? idxHint : state.enemies.indexOf(e);
  if (i >= 0) state.enemies.splice(i, 1);
}

function loseLife(state, pl, n) {
  if (state.gameMode === "coop") {
    state.coopLives -= n;
    if (state.coopLives <= 0) { state.coopLives = 0; defeat(state, state.players[0]); }
  } else {
    pl.lives -= n;
    if (pl.lives <= 0) { pl.lives = 0; defeat(state, pl); }
  }
  state.events.push({ kind: "life", player: pl.id });
}

// ---------------------------------------------------------------------------
// DAMAGE / DEATH
// ---------------------------------------------------------------------------
function damageEnemy(state, e, raw, tower, isDot) {
  if (!e.alive) return;
  let dmg = raw;
  const armor = fx.max(0, e.armor - (e.shred || 0));
  if (!isDot) dmg = fx.max(fx.mul(dmg, F(0.15)), dmg - armor);
  dmg = fx.mul(dmg, e.dmgTakenMult || fx.ONE);
  if (tower) {
    const r = e.resist[tower.def.element] || 0;
    if (r) dmg = fx.mul(dmg, fx.ONE - r);
  }
  e.hp -= dmg;
  if (e.hp <= 0) killEnemy(state, e, tower);
}

function killEnemy(state, e, tower) {
  if (!e.alive) return;
  e.alive = false;
  const fieldPl = state.players[e.owner];
  const creditPl = tower ? state.players[tower.owner] : fieldPl; // per-tower economy (co-op)
  creditPl.stats.kills++;

  // reward — defender keeps it; sent enemies pay a FIXED higher bounty (§8.2).
  let r = e.reward;
  const tag = e.statuses["tagged"];
  if (tag) r = Math.round(r * (tag.def.value / fx.ONE));
  if (e.sent) r = fx.round(fx.mul(fx.fromInt(r), state.bal.competitive.sentBountyMult));
  grantReward(state, creditPl, e, r);

  if (tower) { tower.kills++; checkExpert(state, tower); }
  creditPl.stats.score += e.boss ? 5000 : 25;

  if (e.statuses["volatile"]) aoeAround(state, e, F(2.0), e.statuses["volatile"].def.value);

  if (e.end) { removeEnemy(state, e); victory(state, fieldPl); return; }
  if (e.boss) creditPl.stats.bossesKilled++;
  removeEnemy(state, e);
}

function grantReward(state, pl, e, amount) {
  if (state.economy === "shared") pl.gold += amount;
  else { const el = pl.elements[e.originIndex]; pl.essence[el] = (pl.essence[el] || 0) + amount; }
}
function grantAll(state, pl, amount) {
  if (state.economy === "shared") pl.gold += amount;
  else for (const el of pl.elements) pl.essence[el] += Math.round(amount / pl.corridorCount);
}

function checkExpert(state, tw) {
  if (tw.expert >= state.bal.maxExpert) return;
  const need = state.bal.expertThresholds[tw.expert];
  if (tw.kills >= need) tw.expert++;
}

// ---------------------------------------------------------------------------
// STATUS + SYNERGY
// ---------------------------------------------------------------------------
function applyStatus(state, e, statusId, durationOverride, tower) {
  const def = state.bal.statuses[statusId]; if (!def) return;
  const dur = fx.mul(durationOverride || def.duration, e.boss ? F(0.3) : fx.ONE);
  const incomingElement = def.element;

  for (let i = 0; i < e.statusKeys.length; i++) {
    const k = e.statusKeys[i];
    const ex = state.bal.statuses[k];
    if (!ex || ex.adaptive || ex.element === incomingElement || !incomingElement) continue;
    const syn = state.bal.synergies[k + "|" + incomingElement];
    if (syn) fireSynergy(state, e, syn, tower);
  }

  if (state.statusMode === "standard") {
    for (let i = e.statusKeys.length - 1; i >= 0; i--) {
      const k = e.statusKeys[i];
      if (!state.bal.statuses[k].adaptive) { delete e.statuses[k]; e.statusKeys.splice(i, 1); }
    }
  } else if (e.statusLocked) return;

  addStatus(e, def, statusId, dur);
}
function applyStatusRaw(state, e, statusId, durationOverride) {
  const def = state.bal.statuses[statusId]; if (!def) return;
  addStatus(e, def, statusId, durationOverride || def.duration);
}
function addStatus(e, def, statusId, dur) {
  const existing = e.statuses[statusId];
  if (!existing) e.statusKeys.push(statusId);
  e.statuses[statusId] = {
    def, remaining: dur, value: def.value,
    dotMult: existing ? existing.dotMult : fx.ONE,
    curseBoost: existing ? existing.curseBoost : fx.ONE,
  };
}
function fireSynergy(state, e, syn, tower) {
  state.events.push({ kind: "synergy", player: e.owner, id: syn.id, name: syn.name, corridor: e.corridorIndex });
  if (syn.burst) damageEnemy(state, e, syn.burst, tower, true);
  if (syn.dotMult && e.statuses["poisoned"]) e.statuses["poisoned"].dotMult = syn.dotMult;
  if (syn.curseBoost && e.statuses["cursed"]) e.statuses["cursed"].curseBoost = syn.curseBoost;
  if (syn.execute && !e.boss && fx.div(e.hp, e.maxHp) < syn.execute) damageEnemy(state, e, e.hp + 1, tower);
  if (syn.spread) {
    let n = 0;
    const R2 = fx.mul(F(2), F(2));
    for (const o of state.enemies) {
      if (o === e || !o.alive || o.owner !== e.owner || o.corr !== e.corr) continue;
      if (fx.dist2(e.fx, e.fy, o.fx, o.fy) < R2) {
        for (const k of e.statusKeys) if (!state.bal.statuses[k].adaptive) applyStatusRaw(state, o, k);
        if (++n >= 3) break;
      }
    }
  }
  if (syn.anchor && tower) tower.anchorTargetId = e.id;
}

// ---------------------------------------------------------------------------
// TOWERS — stats + combat
// ---------------------------------------------------------------------------
function towerStats(state, tw) {
  const d = tw.def, lvl = tw.level, S = state.bal.scaling;
  let damage = d.damage, fireRate = d.fireRate, range = d.range;
  // compounding per-level via repeated fixed mul (deterministic)
  for (let l = 1; l < lvl; l++) {
    damage = fx.mul(damage, fx.ONE + S.damagePerLevel);
    fireRate = fx.mul(fireRate, fx.ONE + S.fireRatePerLevel);
  }
  range += fx.mul(S.rangePerLevel, fx.fromInt(lvl - 1));
  let splash = d.splashRadius, chainCount = d.chainCount, chainRange = d.chainRange, pierce = d.pierce, archetype = d.archetype;

  for (const mid of tw.mutations) {
    const m = d.mutations.find(o => o.id === mid); if (!m) continue;
    const mods = m.mods;
    if (mods.damageMult) damage = fx.mul(damage, mods.damageMult);
    if (mods.fireRateMult) fireRate = fx.mul(fireRate, mods.fireRateMult);
    if (mods.rangeMult) range = fx.mul(range, mods.rangeMult);
    if (mods.splashRadius != null) splash = mods.splashRadius;
    if (mods.chainCount != null) chainCount = mods.chainCount;
    if (mods.chainRange) chainRange = mods.chainRange;
    if (mods.pierce != null) pierce = mods.pierce;
    if (mods.archetype) archetype = mods.archetype;
  }
  damage = fx.mul(damage, fx.ONE + state.bal.expertDamageBonus[tw.expert]);
  damage = fx.mul(damage, tw.ampBuff || fx.ONE);
  fireRate = fx.mul(fireRate, tw.hasteBuff || fx.ONE);
  return { damage, fireRate, range, splash, chainCount, chainRange, pierce, archetype, mods: collectMods(d, tw) };
}
function collectMods(d, tw) {
  const m = {};
  for (const mid of tw.mutations) { const o = d.mutations.find(x => x.id === mid); if (o) Object.assign(m, o.mods); }
  return m;
}

function updateTowers(state, pl, corr, dt) {
  for (const tw of corr.towers) { tw.ampBuff = fx.ONE; tw.hasteBuff = fx.ONE; }
  // auras
  for (const tw of corr.towers) {
    const st = towerStats(state, tw);
    if (st.archetype === "support") applyAura(state, corr, tw, st);
  }
  for (const tw of corr.towers) {
    const st = towerStats(state, tw);
    if (st.archetype === "support") { supportTick(state, pl, corr, tw, st, dt); continue; }
    tw.cd -= dt;
    if (tw.cd <= 0) {
      if (fireTower(state, pl, corr, tw, st)) {
        const fr = fx.max(F(0.05), st.fireRate);
        tw.cd = fx.div(fx.ONE, fr);
      }
    }
  }
}

function inRange(tw, x, y, range) { return fx.dist2(tw.cx, tw.cy, x, y) <= fx.mul(range, range); }

function applyAura(state, corr, tw, st) {
  const stat = st.mods.auraStat || tw.def.auraStat;
  const val = st.mods.auraValue || tw.def.auraValue;
  if (stat === "amp_tower") {
    for (const o of corr.towers) if (o !== tw && inRange(tw, o.cx, o.cy, st.range)) o.ampBuff = fx.mul(o.ampBuff, val);
  } else if (stat === "haste_tower") {
    for (const o of corr.towers) if (o !== tw && inRange(tw, o.cx, o.cy, st.range)) o.hasteBuff = fx.mul(o.hasteBuff, val);
  }
}

function supportTick(state, pl, corr, tw, st, dt) {
  const stat = st.mods.auraStat || tw.def.auraStat;
  tw.beamT = (tw.beamT || 0) - dt;
  const pulse = tw.beamT <= 0;
  if (pulse) tw.beamT = F(0.5);
  if (stat === "slow" || tw.def.element === "ice") {
    for (const e of state.enemies) if (e.alive && e.owner === pl.id && e.corr === corr && inRange(tw, e.fx, e.fy, st.range)) {
      applyStatus(state, e, tw.def.status, st.mods.statusDuration || tw.def.statusDuration, tw);
      if (pulse && st.damage > 0) damageEnemy(state, e, st.damage, tw, true);
    }
  } else if (stat === "poison") {
    for (const e of state.enemies) if (e.alive && e.owner === pl.id && e.corr === corr && inRange(tw, e.fx, e.fy, st.range)) {
      applyStatus(state, e, "poisoned", tw.def.statusDuration, tw);
      if (pulse) damageEnemy(state, e, (st.mods.auraValue || tw.def.auraValue), tw, true);
    }
  } else if (stat === "magnet") {
    for (const e of state.enemies) if (e.alive && e.owner === pl.id && e.corr === corr && inRange(tw, e.fx, e.fy, st.range)) applyStatus(state, e, "magnetized", tw.def.statusDuration, tw);
  }
}

function acquireTarget(state, pl, corr, tw, range) {
  let best = null, bestScore = Infinity;
  const G = state.grid;
  const mode = tw.targetMode || "first";
  for (const e of state.enemies) {
    if (!e.alive || e.owner !== pl.id || e.corr !== corr) continue;
    if (!inRange(tw, e.fx, e.fy, range)) continue;
    // per-tower priority (all inputs integers -> deterministic):
    //   first  = closest to the exit (flow-field distance, lower is further along)
    //   last   = furthest from the exit
    //   strong = highest current HP, weak = lowest current HP
    let score;
    if (mode === "strong") score = -e.hp;
    else if (mode === "weak") score = e.hp;
    else {
      score = corr.dist[fx.floorInt(e.fy) * G.cols + fx.floorInt(e.fx)] || 0;
      if (mode === "last") score = -score;
    }
    if (e.statuses["magnetized"]) score -= 1e9;
    if (tw.anchorTargetId === e.id) score -= 5e9;
    // stable tie-break by id
    if (score < bestScore || (score === bestScore && best && e.id < best.id)) { bestScore = score; best = e; }
  }
  return best;
}

function fireTower(state, pl, corr, tw, st) {
  let arche = st.archetype, element = tw.def.element, statusId = tw.def.status;
  if (arche === "random") {
    arche = rng.pick(state.seedSim, ["single", "splash", "chain"]);
    const opts = ["burning", "chilled", "poisoned", "shocked", "weakened", "shredded"];
    statusId = (st.mods.luckyBoost && rng.chance(state.seedSim, HALF)) ? "volatile" : rng.pick(state.seedSim, opts);
  }
  const target = acquireTarget(state, pl, corr, tw, st.range);
  if (!target && arche !== "melee") return false;

  if (arche === "melee") {
    let hit = false;
    for (const e of state.enemies) if (e.alive && e.owner === pl.id && e.corr === corr && inRange(tw, e.fx, e.fy, st.range)) {
      damageEnemy(state, e, st.damage, tw); maybeStatus(state, e, tw, st, statusId); hit = true;
    }
    return hit;
  }
  if (arche === "beam" || arche === "chain") {
    damageEnemy(state, target, st.damage, tw); maybeStatus(state, target, tw, st, statusId);
    if (st.chainCount > 0) chainFrom(state, pl, corr, tw, target, st, statusId);
    return true;
  }
  // single / splash -> projectile
  state.projectiles.push({
    id: state.nextId++, owner: pl.id, corr,
    x: tw.cx, y: tw.cy, targetId: target.id,
    tx: target.fx, ty: target.fy,
    speed: tw.def.projectileSpeed, twId: tw.id, twRef: tw,
    st, arche, statusId, element,
  });
  return true;
}

function maybeStatus(state, e, tw, st, statusId) {
  const chance = st.mods.statusChance || tw.def.statusChance || 0;
  if (statusId && rng.chance(state.seedSim, chance)) applyStatus(state, e, statusId, st.mods.statusDuration || tw.def.statusDuration, tw);
  if (st.mods.addStatus) applyStatus(state, e, st.mods.addStatus, null, tw);
  if (st.mods.executeBoost && !e.boss && fx.div(e.hp, e.maxHp) < F(0.18)) damageEnemy(state, e, e.hp + 1, tw);
}

function chainFrom(state, pl, corr, tw, from, st, statusId) {
  let count = st.chainCount, prev = from;
  const hit = new Set([from.id]);
  let dmg = fx.mul(st.damage, F(0.85));
  const cr = st.chainRange || fx.fromInt(3);
  const cr2 = fx.mul(cr, cr);
  while (count-- > 0) {
    let best = null, bd = cr2;
    for (const e of state.enemies) {
      if (!e.alive || e.owner !== pl.id || e.corr !== corr || hit.has(e.id)) continue;
      const d = fx.dist2(prev.fx, prev.fy, e.fx, e.fy);
      if (d <= bd || (d === bd && best && e.id < best.id)) { bd = d; best = e; }
    }
    if (!best) break;
    damageEnemy(state, best, dmg, tw); maybeStatus(state, best, tw, st, statusId);
    hit.add(best.id); prev = best; dmg = fx.mul(dmg, F(0.85));
  }
}

function findEnemyById(state, id) {
  for (const e of state.enemies) if (e.id === id) return e;
  return null;
}

function updateProjectiles(state, dt) {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    const tgt = p.targetId ? findEnemyById(state, p.targetId) : null;
    if (tgt && tgt.alive) { p.tx = tgt.fx; p.ty = tgt.fy; }
    const dx = p.tx - p.x, dy = p.ty - p.y;
    let d = fx.len(dx, dy); if (d <= 0) d = 1;
    const step = fx.mul(p.speed, dt);
    if (d <= step + F(0.05)) { impact(state, p); state.projectiles.splice(i, 1); }
    else { p.x += fx.div(fx.mul(dx, step), d); p.y += fx.div(fx.mul(dy, step), d); }
  }
}

function impact(state, p) {
  const corr = p.corr, tw = p.twRef;
  if (p.arche === "splash" && p.st.splash > 0) {
    const R2 = fx.mul(p.st.splash, p.st.splash);
    for (const e of state.enemies) {
      if (!e.alive || e.owner !== p.owner || e.corr !== corr) continue;
      if (fx.dist2(p.x, p.y, e.fx, e.fy) <= R2) { damageEnemy(state, e, p.st.damage, tw); maybeStatus(state, e, tw, p.st, p.statusId); }
    }
  } else {
    const tgt = p.targetId ? findEnemyById(state, p.targetId) : null;
    let hits = (p.st.pierce || 0) + 1;
    if (tgt && tgt.alive) { damageEnemy(state, tgt, p.st.damage, tw); maybeStatus(state, tgt, tw, p.st, p.statusId); hits--; }
    if (hits > 0 && p.st.pierce > 0) {
      const R2 = fx.mul(F(1.2), F(1.2));
      for (const e of state.enemies) {
        if (hits <= 0) break;
        if (!e.alive || e === tgt || e.owner !== p.owner || e.corr !== corr) continue;
        if (fx.dist2(p.x, p.y, e.fx, e.fy) <= R2) { damageEnemy(state, e, fx.mul(p.st.damage, F(0.8)), tw); maybeStatus(state, e, tw, p.st, p.statusId); hits--; }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// INCOME (competitive §8.1 + catch-up §8.3)
// ---------------------------------------------------------------------------
function updateIncome(state) {
  if (state.gameMode !== "competitive") return;
  const comp = state.bal.competitive;
  // find life leader for catch-up
  let maxLives = 0;
  for (const pl of state.players) if (pl.alive && pl.lives > maxLives) maxLives = pl.lives;
  for (const pl of state.players) {
    if (!pl.alive) continue;
    pl.incomeTick++;
    if (pl.incomeTick >= comp.incomeIntervalTicks) {
      pl.incomeTick = 0;
      let payout = pl.income;
      const behind = maxLives - pl.lives;
      if (behind > 0) payout += behind * comp.catchupPerLifeBehind; // §8.3 catch-up
      if (payout > 0) grantAll(state, pl, payout);
    }
  }
}

// ---------------------------------------------------------------------------
// WAVE STATE / WIN-LOSS
// ---------------------------------------------------------------------------
function enemiesOf(state, pl) { let n = 0; for (const e of state.enemies) if (e.owner === pl.id) n++; return n; }

function checkWaveState(state, pl) {
  if (!pl.waveActive) return;
  if (pl.spawnQueue.length === 0 && enemiesOf(state, pl) === 0) {
    pl.waveActive = false;
    if (pl.phase === "endboss") return;
    pl.phase = "build";
    const bonus = 40 + pl.wave * 12;
    if (state.gameMode === "coop") { for (const p of state.players) grantAll(state, p, bonus); }
    else grantAll(state, pl, bonus);
    pl.stats.score += pl.wave * 100;
    state.events.push({ kind: "waveClear", player: pl.id, wave: pl.wave, bonus, autosave: true });
    if (state.mode !== "endless" && pl.wave >= pl.totalWaves) {
      pl.phase = "prep";
      state.events.push({ kind: "prep", player: pl.id });
    }
  }
}

function summonEndBoss(state, pl) {
  if (pl.phase !== "prep") return;
  const origin = rng.nextInt(state.seedSim, pl.corridorCount);
  spawnEnemy(state, pl, "endboss", origin, pl.wave, false);
  pl.endBossId = state.enemies[state.enemies.length - 1].id;
  pl.phase = "endboss";
  pl.waveActive = true;
  state.events.push({ kind: "endboss", player: pl.id });
}

function victory(state, pl) {
  if (pl.phase === "victory") return;
  pl.phase = "victory"; pl.waveActive = false;
  state.events.push({ kind: "victory", player: pl.id });
  maybeFinish(state);
}
function defeat(state, pl) {
  if (pl.phase === "defeat") return;
  pl.phase = "defeat"; pl.waveActive = false; pl.alive = false;
  state.events.push({ kind: "defeat", player: pl.id });
  // competitive: last standing wins
  if (state.gameMode === "competitive") {
    const alive = state.players.filter(p => p.alive);
    if (alive.length === 1) { alive[0].phase = "victory"; state.events.push({ kind: "victory", player: alive[0].id }); }
  }
  maybeFinish(state);
}
function maybeFinish(state) {
  if (state.gameMode === "coop") {
    const f = state.players[0].phase;
    if (f === "victory" || f === "defeat") state.finished = true;
    return;
  }
  const anyOngoing = state.players.some(p => p.phase !== "victory" && p.phase !== "defeat");
  if (!anyOngoing) state.finished = true;
}

export default { createState, step, SIM_HZ };
