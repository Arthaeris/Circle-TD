/* =============================================================================
 * Circle Tower Wars — app/main.js
 * THE SHELL ORCHESTRATOR (§2 "app/" layer). Bootstraps assets, wires input to
 * COMMANDS, runs the fixed-timestep loop (§4), drives either the solo sim or
 * the lockstep/Firebase multiplayer sim (§6), renders with interpolation, and
 * handles autosave-per-wave (§9), the local render-fps preference (§4), and
 * Service-Worker registration (§10). It is the ONLY place local actions turn
 * into commands; it never mutates sim state directly.
 * ===========================================================================*/
import * as fx from "../sim/fx.js";
import { createState, step, SIM_HZ } from "../sim/core.js";
import { buildBalance } from "../sim/balance.js";
import { hashContent } from "../sim/hash.js";
import * as C from "../net/commands.js";
import { createLockstep } from "../net/lockstep.js";
import { createLoop } from "./loop.js";
import { createAssets, collectPreloadAssets } from "../render/assets.js";
import { createRenderer } from "../render/draw.js";
import { createUI } from "../ui/shell.js";

const $ = (id) => document.getElementById(id);
const DB = window.DB;
const SaveSystem = window.SaveSystem;
const RUN_KEY = "ctw_run_v2";

const bal = buildBalance(DB);
DB.contentHash = hashContent(DB);   // content-gating fingerprint (§6.4)
const SIM_DT = fx.fromFloat(1 / SIM_HZ);

// ---- shell state (NOT the sim state) ---------------------------------------
const game = {
  state: null, me: 0,
  screen: "menu", view: "world", activeCorridor: 0,
  speed: 1, time: 0,
  mode: "loop", gameMode: "solo",
  selectedTowerId: null, selectedEnemyId: null, buildTile: null, buildMenuOpen: false,
  fieldCam: { x: 0, y: 0, zoom: 1 },
  driver: null,                      // solo or lockstep driver
  lockstep: null, room: null,
  _vortex: null, time0: 0,
};
let meta = SaveSystem ? SaveSystem.loadMeta() : { mastery: {} };

let canvas, assets, renderer, ui, loop;

function masteryLevel(el) { return (meta.mastery && meta.mastery[el]) || 0; }

// view object the renderer + ui read (player resolves live)
const view = {
  get state() { return game.state; }, get me() { return game.me; },
  get player() { return game.state.players[game.me]; },
  get screen() { return game.screen; }, get view() { return game.view; },
  get activeCorridor() { return game.activeCorridor; },
  get time() { return game.time; }, get speed() { return game.speed; },
  get selectedTowerId() { return game.selectedTowerId; }, set selectedTowerId(x) { game.selectedTowerId = x; },
  get selectedEnemyId() { return game.selectedEnemyId; }, set selectedEnemyId(x) { game.selectedEnemyId = x; },
  get buildTile() { return game.buildTile; }, set buildTile(x) { game.buildTile = x; },
  get buildMenuOpen() { return game.buildMenuOpen; }, set buildMenuOpen(x) { game.buildMenuOpen = x; },
  fieldCam: game.fieldCam,
  fieldTopInset: () => fieldTopInset(),
  set _vortex(x) { game._vortex = x; }, get _vortex() { return game._vortex; },
};

// ---- command emitters: local intent -> commands (solo applies immediately;
//      multiplayer routes through the lockstep produce buffer). ---------------
function emit(c) {
  if (!game.driver) return;
  c.player = game.me;
  if (c.masteryLevel == null && (c.type === "BuildTower" || c.type === "MutateTower")) {
    const corr = game.state.players[game.me].corridors[c.corridorId];
    c.masteryLevel = corr ? masteryLevel(corr.element) : 5;
  }
  game.driver.queue(c);
}
const cmd = {
  build: (corridorId, gx, gy, towerType) => emit(C.buildTower(game.me, corridorId, gx, gy, towerType, masteryLevel(game.state.players[game.me].corridors[corridorId].element))),
  sell: (corridorId, towerId) => emit(C.sellTower(game.me, corridorId, towerId)),
  upgrade: (corridorId, towerId) => emit(C.upgradeTower(game.me, corridorId, towerId)),
  mutate: (corridorId, towerId, mutId) => emit(C.mutateTower(game.me, corridorId, towerId, mutId, masteryLevel(game.state.players[game.me].corridors[corridorId].element))),
  startWave: () => emit(C.startWave(game.me)),
  send: (target, enemyType) => emit(C.sendEnemy(game.me, target, enemyType)),
};

// ---------------------------------------------------------------------------
// DRIVERS — solo (local) and multiplayer (lockstep)
// ---------------------------------------------------------------------------
function makeSoloDriver(state) {
  let pending = [];
  return {
    queue(c) { pending.push(c); },
    tick() {
      // solo respects the local speed multiplier by running N ticks
      for (let i = 0; i < game.speed; i++) {
        const cmds = pending; pending = [];
        step(state, C.orderCommands(cmds), SIM_DT);
        afterTick(state);
        if (state.finished) break;
      }
    },
  };
}

function makeNetDriver(state, ls) {
  let pending = [];
  return {
    queue(c) { pending.push(c); },          // speed is fixed (×1) in multiplayer
    tick() {
      ls.produce(pending); pending = [];
      ls.advance(2);
      afterTick(state);
    },
  };
}

// Runs once per executed sim tick: interpolation snapshot + event handling.
function afterTick(state) {
  renderer.snapshotPositions(state);
  game.time = state.tick / SIM_HZ;
  if (state.events && state.events.length) for (const ev of state.events) handleEvent(ev);
}

function handleEvent(ev) {
  if (ev.player !== game.me && game.gameMode !== "coop") {
    if (ev.kind === "sent" && ev.to === game.me) ui.toast("⚠ Enemies incoming!");
    return;
  }
  switch (ev.kind) {
    case "wave": ui.updateTopBar(); ui.updateWavePanel(); break;
    case "waveClear":
      ui.toast(`Wave ${ev.wave} cleared! +${ev.bonus}`);
      if (ev.autosave) autosave();             // D3 — autosave after every wave
      ui.updateTopBar(); ui.updateWavePanel(); ui.updateEnemyOverview(); break;
    case "prep": ui.toast("Final wave cleared! Summon the End Boss from the Vortex."); break;
    case "endboss": ui.toast("THE SEALED ONE awakens!"); break;
    case "life": ui.updateTopBar(); flash("#ff4d6d"); break;
    case "victory": endScreen(true); break;
    case "defeat": endScreen(false); break;
  }
}

// ---------------------------------------------------------------------------
// SCREENS
// ---------------------------------------------------------------------------
function showScreen(s) {
  game.screen = s;
  ["loading", "menu", "setup", "game"].forEach((x) => { const el = $("screen-" + x); if (el) el.classList.toggle("active", x === s); });
}
function refreshMenu() { const c = $("btn-continue"); if (c) c.classList.toggle("disabled", !localStorage.getItem(RUN_KEY)); }

// ---------------------------------------------------------------------------
// SETUP -> START RUN
// ---------------------------------------------------------------------------
const setup = { mode: "loop", corridors: 4, economy: "shared", status: "standard", gameMode: "solo", elements: [] };
function openSetup() {
  const avail = DB.availableElements(meta.mastery);
  setup.elements = []; for (let i = 0; i < 8; i++) setup.elements.push(avail[i % avail.length]);
  showScreen("setup"); ui.renderSetup(setup, DB.availableElements(meta.mastery));
}

function startRun(cfg, seed) {
  game.gameMode = cfg.gameMode || "solo";
  game.mode = cfg.mode;
  const corridorCount = cfg.mode === "single" ? 1 : cfg.corridors;
  const players = [{ corridorCount, elements: cfg.elements.slice(0, corridorCount) }];
  if (game.gameMode !== "solo") for (let i = 1; i < (cfg.playerCount || 2); i++) players.push({ corridorCount, elements: cfg.elements.slice(0, corridorCount) });
  const stateCfg = {
    seed: seed != null ? seed : ((Math.random() * 1e9) | 0),
    mode: cfg.mode, gameMode: game.gameMode, economy: cfg.economy, statusMode: cfg.status, players,
  };
  game.state = createState(bal, stateCfg);
  game.me = cfg.me || 0; game.speed = 1; game.time = 0;
  game.view = "world"; game.activeCorridor = 0; game.fieldCam = { x: 0, y: 0, zoom: 1 }; view.fieldCam = game.fieldCam;
  game.selectedTowerId = game.selectedEnemyId = game.buildTile = null;
  game.driver = (game.gameMode === "solo") ? makeSoloDriver(game.state) : makeNetDriver(game.state, game.lockstep);
  showScreen("game"); resize();
  ui.closeAllPanels(); setView("world", true);
  ui.updateTopBar(); ui.updateEnemyOverview(); ui.updateWavePanel();
  ui.toast("Build your defenses, then start the wave.");
  return stateCfg.seed;
}

// ---------------------------------------------------------------------------
// AUTOSAVE (§9) + CONTINUE — compact between-wave snapshot keyed separately
// from the legacy save so old saves are untouched.
// ---------------------------------------------------------------------------
function serializeRun() {
  const s = game.state, pl = s.players[game.me];
  return {
    v: 2, seed: s.seedBase, mode: s.mode, gameMode: "solo", economy: s.economy, statusMode: s.statusMode,
    corridorCount: pl.corridorCount, elements: pl.elements.slice(),
    gold: pl.gold, essence: Object.assign({}, pl.essence), lives: pl.lives, wave: pl.wave, phase: pl.phase,
    stats: Object.assign({}, pl.stats),
    corridors: pl.corridors.map((c) => ({ towers: c.towers.map((t) => ({ defId: t.def.id, c: t.c, r: t.r, level: t.level, expert: t.expert, kills: t.kills, mutations: t.mutations.slice() })), spawnedTotal: c.spawnedTotal })),
  };
}
function autosave() { try { localStorage.setItem(RUN_KEY, JSON.stringify(serializeRun())); } catch (e) {} }
function hasRun() { return !!localStorage.getItem(RUN_KEY); }
function continueRun() {
  const raw = localStorage.getItem(RUN_KEY); if (!raw) return;
  let d; try { d = JSON.parse(raw); } catch (e) { return; }
  startRun({ mode: d.mode, corridors: d.corridorCount, economy: d.economy, status: d.statusMode, gameMode: "solo", elements: d.elements }, d.seed);
  const pl = game.state.players[0];
  pl.gold = d.gold; pl.essence = Object.assign(pl.essence, d.essence); pl.lives = d.lives; pl.wave = d.wave; pl.phase = d.phase === "wave" || d.phase === "endboss" ? "build" : d.phase;
  pl.stats = Object.assign(pl.stats, d.stats || {});
  // rebuild towers via Build commands (deterministic placement)
  d.corridors.forEach((cd, ci) => { cd.towers.forEach((t) => {
    emit(C.buildTower(0, ci, t.c + 1, t.r + 1, t.defId, 5)); // +1 because build centers on tap tile
  }); });
  game.driver.tick(); // apply queued builds
  // restore tower level/expert by replaying upgrades (level-1 times)
  d.corridors.forEach((cd, ci) => { const corr = pl.corridors[ci]; cd.towers.forEach((tDef, i) => { const tw = corr.towers[i]; if (!tw) return; tw.level = tDef.level; tw.expert = tDef.expert; tw.kills = tDef.kills; tw.mutations = tDef.mutations.slice(); }); });
  ui.updateTopBar(); ui.updateEnemyOverview(); ui.updateWavePanel();
  ui.toast("Run loaded");
}

// ---------------------------------------------------------------------------
// VIEW NAV + INPUT
// ---------------------------------------------------------------------------
function setView(v, instant) {
  game.view = v; ui.closeAllPanels();
  const nav = $("field-nav"); if (nav) nav.classList.toggle("show", v === "field");
  const ov = $("enemy-overview"); if (ov) ov.classList.toggle("show", v === "world");
  if (v === "field") updateCorridorName();
}
function enterCorridor(i) { game.activeCorridor = i; if (game.view === "field") { ui.closeAllPanels(); updateCorridorName(); } else setView("field"); }
function updateCorridorName() { const corr = game.state.players[game.me].corridors[game.activeCorridor]; if (!corr) return; const el = DB.ELEMENTS[corr.element]; const nm = $("corridor-name"); if (nm) nm.innerHTML = `${el.icon} ${el.name} Corridor`; }
function fieldTopInset() { const nav = $("field-nav"); if (!nav || !nav.classList.contains("show")) return 12; const stage = $("game-stage"); if (!stage) return 12; return Math.max(12, nav.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + 10); }
function flash(color) { const o = $("screen-flash"); if (!o) return; o.style.background = color; o.classList.add("flash"); setTimeout(() => o.classList.remove("flash"), 200); }
function clampZoom() { game.fieldCam.zoom = Math.max(1, Math.min(4, game.fieldCam.zoom)); }

function onCanvasClick(ev) {
  if (game.screen !== "game") return;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const pl = game.state.players[game.me];
  if (game.view === "world") {
    if (game._vortex && pl.phase === "prep") { const dx = px - game._vortex.cx, dy = py - game._vortex.cy; if (dx * dx + dy * dy < game._vortex.r * game._vortex.r) { cmd.startWave(); return; } }
    const gates = renderer.gatePositions(view);
    for (let i = 0; i < gates.length; i++) { const dx = px - gates[i].x, dy = py - gates[i].y; if (dx * dx + dy * dy < 34 * 34) { enterCorridor(i); return; } }
    return;
  }
  const { ts, ox, oy } = renderer.fieldGeom(view);
  const fxv = (px - ox) / ts, fyv = (py - oy) / ts;
  const corr = pl.corridors[game.activeCorridor];
  let near = null, nd = 0.7 * 0.7;
  for (const e of game.state.enemies) { if (e.owner !== game.me || e.corridorIndex !== corr.index) continue; const ex = fx.toFloat(e.fx), ey = fx.toFloat(e.fy); const dx = fxv - ex, dy = fyv - ey, d = dx * dx + dy * dy; if (d < nd) { nd = d; near = e; } }
  const c = Math.floor(fxv), r = Math.floor(fyv);
  if (c < 0 || r < 0 || c >= game.state.grid.cols || r >= game.state.grid.rows) { ui.closeAllPanels(); return; }
  const cell = corr.grid[r * game.state.grid.cols + c];
  if (cell === 2) { const tw = towerAt(corr, c, r); if (tw) { ui.openTowerPanel(corr, tw); return; } }
  if (near) { ui.openEnemyPanel(near); return; }
  if (cell === 0) { ui.openBuildMenu(corr, { c, r }); return; }
  ui.closeAllPanels();
}
function towerAt(corr, c, r) { const S = DB.CONFIG.towerSize; for (const t of corr.towers) if (c >= t.c && c < t.c + S && r >= t.r && r < t.r + S) return t; return null; }

// ---------------------------------------------------------------------------
// END SCREEN
// ---------------------------------------------------------------------------
function endScreen(win) {
  const pl = game.state.players[game.me];
  if (SaveSystem) {
    const proxy = { mode: game.mode, elements: pl.elements, wave: pl.wave, totalWaves: pl.totalWaves, score: pl.stats.score };
    try { if (win) SaveSystem.recordVictory(meta, proxy); else SaveSystem.recordDefeat(meta, proxy); SaveSystem.saveMeta(meta); } catch (e) {}
  }
  localStorage.removeItem(RUN_KEY);
  const sc = $("end-screen"); if (!sc) return;
  sc.querySelector("#end-title").textContent = win ? "VICTORY" : "DEFEAT";
  sc.querySelector("#end-title").className = win ? "win" : "lose";
  sc.querySelector("#end-body").innerHTML = `<div class="end-stat">Waves <b>${pl.wave}</b></div><div class="end-stat">Kills <b>${pl.stats.kills}</b></div><div class="end-stat">Bosses <b>${pl.stats.bossesKilled}</b></div><div class="end-stat">Score <b>${pl.stats.score}</b></div>`;
  sc.classList.add("show");
}

// ---------------------------------------------------------------------------
// RESIZE
// ---------------------------------------------------------------------------
function resize() { if (renderer) renderer.resize(); }

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
function boot() {
  canvas = $("game-canvas");
  assets = createAssets(() => canvas.getContext("2d"));
  renderer = createRenderer({ canvas, assets, DB });
  ui = createUI({ DB, getView: () => view, cmd, masteryLevel, enterCorridor });

  bindUI();
  resize();
  window.addEventListener("resize", resize);
  preventBrowserGestures();
  registerServiceWorker();

  showScreen("loading");
  assets.preload(collectPreloadAssets(DB), (done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 100;
    const fill = $("loading-fill"); if (fill) fill.style.width = pct + "%";
    const text = $("loading-text"); if (text) text.textContent = `Loading assets... ${pct}%`;
  }).then(() => { showScreen("menu"); refreshMenu(); });

  loop = createLoop({
    onTick: () => { if (game.driver) game.driver.tick(); },
    onRender: (alpha) => { if (game.screen === "game") renderer.render(view, alpha); },
    isRunning: () => game.screen === "game" && !game.paused && phaseRunning(),
  });
  loop.start();
  setInterval(() => { if (game.screen === "game") ui.updateTopBar(); }, 250);
}
function phaseRunning() { if (!game.state) return false; const pl = game.state.players[game.me]; return ["build", "wave", "prep", "endboss"].includes(pl.phase); }

function bindUI() {
  canvas.addEventListener("click", onCanvasClick);
  bindTouch();
  bind("btn-new-run", openSetup);
  bind("btn-continue", () => { if (hasRun()) continueRun(); });
  bind("btn-mastery", () => {});
  bind("btn-menu-save", () => { const m = $("save-modal"); if (m) m.classList.add("show"); });
  bind("btn-setup-back", () => showScreen("menu"));
  bind("btn-start-run", () => { startRun({ mode: setup.mode, corridors: setup.corridors, economy: setup.economy, status: setup.status, gameMode: setup.gameMode, elements: setup.elements }); });
  document.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { setup.mode = b.dataset.mode; if (setup.mode === "single") setup.corridors = 1; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-econ]").forEach((b) => b.onclick = () => { setup.economy = b.dataset.econ; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-status]").forEach((b) => b.onclick = () => { setup.status = b.dataset.status; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-gamemode]").forEach((b) => b.onclick = () => { setup.gameMode = b.dataset.gamemode; document.querySelectorAll("[data-gamemode]").forEach((x) => x.classList.toggle("sel", x === b)); if (setup.gameMode !== "solo") ui.toast("Multiplayer: create/join a room from the menu, then start."); });
  document.querySelectorAll("[data-fps]").forEach((b) => b.onclick = () => { if (loop) loop.setRenderFps(+b.dataset.fps); document.querySelectorAll("[data-fps]").forEach((x) => x.classList.toggle("sel", x === b)); ui.toast("Render rate: " + b.dataset.fps + " fps"); });
  bind("btn-world", () => setView("world"));
  bind("btn-prev-corridor", () => enterCorridor((game.activeCorridor - 1 + game.state.players[game.me].corridorCount) % game.state.players[game.me].corridorCount));
  bind("btn-next-corridor", () => enterCorridor((game.activeCorridor + 1) % game.state.players[game.me].corridorCount));
  bind("quick-start-wave", () => cmd.startWave());
  bind("quick-speed-cycle", () => { if (game.gameMode === "solo") { game.speed = game.speed >= 3 ? 1 : game.speed + 1; ui.updateWavePanel(); } else ui.toast("Speed is fixed in multiplayer"); });
  bind("btn-settings-ingame", () => togglePause(true));
  bind("pause-resume", () => togglePause(false));
  bind("pause-restart", () => { togglePause(false); startRun({ mode: game.mode, corridors: game.state.players[game.me].corridorCount, economy: game.state.economy, status: game.state.statusMode, gameMode: "solo", elements: game.state.players[game.me].elements }); });
  bind("pause-save", () => { autosave(); ui.toast("Run saved to this device"); });
  bind("pause-exit", () => { togglePause(false); showScreen("menu"); refreshMenu(); });
  bind("end-again", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); startRun({ mode: game.mode === "endless" ? "loop" : game.mode, corridors: game.state.players[game.me].corridorCount, economy: game.state.economy, status: game.state.statusMode, gameMode: "solo", elements: game.state.players[game.me].elements }); });
  bind("end-menu", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); showScreen("menu"); refreshMenu(); });
  bind("end-endless", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); game.state.players[game.me].phase = "build"; game.state.mode = "endless"; ui.toast("Endless Mode!"); });
  bind("sm-close", () => $("save-modal").classList.remove("show"));
  // keyboard
  window.addEventListener("keydown", (e) => {
    if (game.screen !== "game") return;
    if (e.key === " ") { e.preventDefault(); cmd.startWave(); }
    else if (e.key === "Escape") togglePause();
    else if (e.key.toLowerCase() === "w") setView("world");
    else if (game.gameMode === "solo" && (e.key === "1" || e.key === "2" || e.key === "3")) { game.speed = +e.key; ui.updateWavePanel(); }
  });
}
function bind(id, fn) { const e = $(id); if (e) e.onclick = fn; }
function togglePause(force) { game.paused = force != null ? force : !game.paused; const o = $("pause-overlay"); if (o) o.classList.toggle("show", game.paused); }

function bindTouch() {
  let ts = null;
  canvas.addEventListener("wheel", (ev) => {
    if (game.screen !== "game" || game.view !== "field") return; ev.preventDefault();
    if (ev.ctrlKey) { game.fieldCam.zoom *= ev.deltaY < 0 ? 1.1 : 0.9; clampZoom(); } else { game.fieldCam.y -= ev.deltaY; }
  }, { passive: false });
  canvas.addEventListener("touchstart", (ev) => {
    if (game.screen !== "game" || game.view !== "field") return;
    if (ev.touches.length === 1) ts = { mode: "pan", x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.touches.length === 2) { const a = ev.touches[0], b = ev.touches[1]; ts = { mode: "pinch", dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: game.fieldCam.zoom }; }
  }, { passive: false });
  canvas.addEventListener("touchmove", (ev) => {
    if (game.screen !== "game" || game.view !== "field" || !ts) return; ev.preventDefault();
    if (ts.mode === "pan" && ev.touches.length === 1) { const t = ev.touches[0]; game.fieldCam.x += t.clientX - ts.x; game.fieldCam.y += t.clientY - ts.y; ts.x = t.clientX; ts.y = t.clientY; }
    if (ts.mode === "pinch" && ev.touches.length === 2) { const a = ev.touches[0], b = ev.touches[1]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); game.fieldCam.zoom = ts.zoom * (d / ts.dist); clampZoom(); }
  }, { passive: false });
  canvas.addEventListener("touchend", () => { ts = null; }, { passive: false });
}

function preventBrowserGestures() {
  let lastEnd = 0;
  document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastEnd <= 300) e.preventDefault(); lastEnd = now; }, { passive: false });
  ["gesturestart", "gesturechange", "gestureend"].forEach((g) => document.addEventListener(g, (e) => e.preventDefault(), { passive: false }));
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

export default { boot };
