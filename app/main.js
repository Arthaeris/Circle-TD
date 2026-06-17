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
import { createState, step, SIM_HZ, findBuildSpot } from "../sim/core.js";
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
  speed: 1, time: 0, clock: 0,
  lobby: null,
  mode: "loop", gameMode: "solo",
  selectedTowerId: null, selectedEnemyId: null, buildTile: null, buildMenuOpen: false, buildSpot: null,
  fieldCam: { x: 0, y: 0, zoom: 1 },
  driver: null,                      // solo or lockstep driver
  lockstep: null, room: null,
  _vortex: null, time0: 0,
};
let meta = SaveSystem ? SaveSystem.loadMeta() : { mastery: {} };

let canvas, assets, renderer, ui, loop;
let musicMenu = null, musicGame = null, musicUnlocked = false;
function initAudio() {
  try {
    musicMenu = new Audio("assets/audio/music_menu.mp3"); musicMenu.loop = true; musicMenu.volume = 0.4;
    musicGame = new Audio("assets/audio/music_game.mp3"); musicGame.loop = true; musicGame.volume = 0.4;
  } catch (e) {}
}
function unlockMusic() { musicUnlocked = true; }
function playMenuMusic() { if (!musicUnlocked || !musicMenu) return; if (musicGame) musicGame.pause(); if (musicMenu.paused) musicMenu.play().catch(() => {}); }
function playGameMusic() { if (!musicUnlocked || !musicGame) return; if (musicMenu) musicMenu.pause(); if (musicGame.paused) musicGame.play().catch(() => {}); }

function masteryLevel(el) { return (meta.mastery && meta.mastery[el]) || 0; }
function fieldId() { return game.gameMode === "coop" ? 0 : game.me; }
function fieldPlayer() { return game.state.players[fieldId()]; }

// view object the renderer + ui read (player resolves live)
const view = {
  get state() { return game.state; }, get me() { return game.me; },
  get player() { return game.state.players[game.me]; },
  get fieldId() { return game.gameMode === "coop" ? 0 : game.me; },
  get field() { return game.state.players[game.gameMode === "coop" ? 0 : game.me]; },
  get screen() { return game.screen; }, get view() { return game.view; },
  get activeCorridor() { return game.activeCorridor; },
  get time() { return game.clock; }, get speed() { return game.gameMode === "solo" ? game.speed : ((game.state && game.state.netSpeed) || 1); },
  get selectedTowerId() { return game.selectedTowerId; }, set selectedTowerId(x) { game.selectedTowerId = x; },
  get selectedEnemyId() { return game.selectedEnemyId; }, set selectedEnemyId(x) { game.selectedEnemyId = x; },
  get buildTile() { return game.buildTile; }, set buildTile(x) { game.buildTile = x; },
  get buildMenuOpen() { return game.buildMenuOpen; }, set buildMenuOpen(x) { game.buildMenuOpen = x; },
  get buildSpot() { return game.buildSpot; }, set buildSpot(x) { game.buildSpot = x; },
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
    const corr = fieldPlayer().corridors[c.corridorId];
    c.masteryLevel = corr ? masteryLevel(corr.element) : 5;
  }
  game.driver.queue(c);
}
const cmd = {
  build: (corridorId, gx, gy, towerType) => emit(C.buildTower(game.me, corridorId, gx, gy, towerType, masteryLevel(fieldPlayer().corridors[corridorId].element))),
  sell: (corridorId, towerId) => emit(C.sellTower(game.me, corridorId, towerId)),
  upgrade: (corridorId, towerId) => emit(C.upgradeTower(game.me, corridorId, towerId)),
  mutate: (corridorId, towerId, mutId) => emit(C.mutateTower(game.me, corridorId, towerId, mutId, masteryLevel(fieldPlayer().corridors[corridorId].element))),
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
      const cmds = pending; pending = [];
      step(state, C.orderCommands(cmds), SIM_DT);
      afterTick(state);
    },
  };
}

function makeNetDriver(state, ls) {
  return {
    queue(c) { ls.queueLocal([c]); },
    tick() { ls.tickFrame(); },             // turn-based: produces turns + runs ready ticks
  };
}

// Runs once per executed sim tick: interpolation snapshot + event handling.
function afterTick(state) {
  renderer.snapshotPositions(state);
  if (state.events && state.events.length) for (const ev of state.events) handleEvent(ev);
}

function handleEvent(ev) {
  if (ev.player !== game.me && game.gameMode !== "coop") {
    if (ev.kind === "sent" && ev.to === game.me) ui.toast("⚠ Enemies incoming!");
    return;
  }
  switch (ev.kind) {
    case "wave": ui.updateTopBar(); ui.updateWavePanel(); ui.toast(ev.boss ? ("\u26A0 Wave " + ev.wave + " \u2014 BOSS WAVE") : ("Wave " + ev.wave + " incoming")); break;
    case "reject": { const M = { funds: (game.state.economy === "shared" ? "Not enough gold." : "Not enough essence."), noRoom: "No room \u2014 towers need 3\u00D73 space and can\u2019t fully block the path.", needMax: "Reach max level to mutate.", noSlots: "No mutation slots \u2014 raise Mastery." }; ui.toast(M[ev.reason] || "Cannot do that here."); break; }
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
  if (s === "menu") playMenuMusic(); else if (s === "game") playGameMusic();
}
function refreshMenu() { const c = $("btn-continue"); if (c) c.classList.toggle("disabled", !localStorage.getItem(RUN_KEY)); }

// ---------------------------------------------------------------------------
// SETUP -> START RUN
// ---------------------------------------------------------------------------
const setup = { mode: "loop", corridors: 4, economy: "shared", status: "standard", gameMode: "solo", elements: [] };
function openSetup() {
  const avail = DB.availableElements(meta.mastery);
  setup.elements = []; for (let i = 0; i < 8; i++) setup.elements.push(avail[i % avail.length]);
  if (!game.mpHosting && lobbyPlayerCount() < 2 && setup.gameMode !== "solo") setup.gameMode = "solo";
  showScreen("setup"); ui.renderSetup(setup, DB.availableElements(meta.mastery)); updateGameModeButtons();
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
  game.mpHosting = false;
  game.me = cfg.me || 0; game.speed = 1; game.clock = 0;
  game.view = "world"; game.activeCorridor = 0; game.fieldCam = { x: 0, y: 0, zoom: 1 }; view.fieldCam = game.fieldCam;
  game.selectedTowerId = game.selectedEnemyId = game.buildTile = null;
  game.driver = (game.gameMode === "solo") ? makeSoloDriver(game.state) : makeNetDriver(game.state, game.lockstep);
  if (sendBtn) sendBtn.style.display = "none";
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
  restoreRun(d);
}
function restoreRun(d) {
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
  if (v === "field") { updateCorridorName(); clampFieldCamera(); }
}
function enterCorridor(i) { game.activeCorridor = i; if (game.view === "field") { ui.closeAllPanels(); updateCorridorName(); } else setView("field"); }
function updateCorridorName() { const corr = fieldPlayer().corridors[game.activeCorridor]; if (!corr) return; const el = DB.ELEMENTS[corr.element]; const nm = $("corridor-name"); if (nm) nm.innerHTML = `${el.icon} ${el.name} Corridor`; }
function fieldTopInset() { const nav = $("field-nav"); if (!nav || !nav.classList.contains("show")) return 12; const stage = $("game-stage"); if (!stage) return 12; return Math.max(12, nav.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + 10); }
function flash(color) { const o = $("screen-flash"); if (!o) return; o.style.background = color; o.classList.add("flash"); setTimeout(() => o.classList.remove("flash"), 200); }
function clampZoom() { game.fieldCam.zoom = Math.max(1, Math.min(4, game.fieldCam.zoom)); }

function onCanvasClick(ev) {
  if (game.screen !== "game") return;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  const pl = fieldPlayer();
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
  for (const e of game.state.enemies) { if (e.owner !== fieldId() || e.corridorIndex !== corr.index) continue; const ex = fx.toFloat(e.fx), ey = fx.toFloat(e.fy); const dx = fxv - ex, dy = fyv - ey, d = dx * dx + dy * dy; if (d < nd) { nd = d; near = e; } }
  const c = Math.floor(fxv), r = Math.floor(fyv);
  if (c < 0 || r < 0 || c >= game.state.grid.cols || r >= game.state.grid.rows) { ui.closeAllPanels(); return; }
  const cell = corr.grid[r * game.state.grid.cols + c];
  if (cell === 2) { const tw = towerAt(corr, c, r); if (tw) { ui.openTowerPanel(corr, tw); return; } }
  if (near) { ui.openEnemyPanel(near); return; }
  if (cell === 0) { game.buildSpot = findBuildSpot(game.state, fieldId(), corr.index, c, r); ui.openBuildMenu(corr, { c, r }); return; }
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
function resize() { if (renderer) renderer.resize(); if (game.state && game.view === "field") clampFieldCamera(); }

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
function boot() {
  canvas = $("game-canvas");
  assets = createAssets(() => canvas.getContext("2d"));
  renderer = createRenderer({ canvas, assets, DB });
  ui = createUI({ DB, getView: () => view, cmd, masteryLevel, enterCorridor, getMeta: () => meta });

  initAudio();
  const unlockOnce = () => { unlockMusic(); (game.screen === "game" ? playGameMusic() : playMenuMusic()); document.removeEventListener("pointerdown", unlockOnce); };
  document.addEventListener("pointerdown", unlockOnce);
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
    onFrame: (dt, running) => { if (running) game.clock += dt; }, // real wall-clock (speed-independent)
    getSpeed: () => game.gameMode === "solo" ? game.speed : ((game.state && game.state.netSpeed) || 1),
    onRender: (alpha) => { if (game.screen === "game") renderer.render(view, alpha); },
    isRunning: () => {
      if (game.screen !== "game" || game.paused) return false;
      if (game.gameMode !== "solo") return !(game.state && game.state.finished);
      return phaseRunning();
    },
  });
  loop.start();
  setInterval(() => { if (game.screen === "game") { ui.updateTopBar(); ui.refreshPanels(); } }, 250);
}
function phaseRunning() { if (!game.state) return false; const pl = game.state.players[game.me]; return ["build", "wave", "prep", "endboss"].includes(pl.phase); }

function bindUI() {
  canvas.addEventListener("click", onCanvasClick);
  const ovp = $("enemy-overview");
  if (ovp) ovp.addEventListener("click", (e) => { if (e.target.closest(".ov-head")) ovp.classList.toggle("collapsed"); });
  bindTouch();
  bind("btn-new-run", openSetup);
  bind("btn-continue", () => { if (hasRun()) continueRun(); });
  bind("btn-mastery", () => ui.openMastery());
  bind("btn-menu-save", () => { const m = $("save-modal"); if (m) m.classList.add("show"); });
  bind("btn-setup-back", () => { if (game.mpHosting && game.lobby) { game.mpHosting = false; window.CTWMultiplayer.setRoomStatus(game.lobby.roomId, "lobby").catch(() => {}); openLobby(); } else showScreen("menu"); });
  bind("btn-start-run", () => { if (game.mpHosting) { beginMultiplayerMatch(); return; } startRun({ mode: setup.mode, corridors: setup.corridors, economy: setup.economy, status: setup.status, gameMode: setup.gameMode, elements: setup.elements }); });
  document.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { setup.mode = b.dataset.mode; if (setup.mode === "single") setup.corridors = 1; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-econ]").forEach((b) => b.onclick = () => { setup.economy = b.dataset.econ; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-status]").forEach((b) => b.onclick = () => { setup.status = b.dataset.status; ui.renderSetup(setup, DB.availableElements(meta.mastery)); });
  document.querySelectorAll("[data-gamemode]").forEach((b) => b.onclick = () => {
    if (game.mpHosting) { ui.toast("Match type is set by the room"); return; }
    const mp = b.dataset.gamemode !== "solo";
    if (mp && lobbyPlayerCount() < 2) { ui.toast("Join a multiplayer room with another player first."); return; }
    setup.gameMode = b.dataset.gamemode;
    updateGameModeButtons();
  });
  document.querySelectorAll("[data-fps]").forEach((b) => b.onclick = () => { if (loop) loop.setRenderFps(+b.dataset.fps); document.querySelectorAll("[data-fps]").forEach((x) => x.classList.toggle("sel", x === b)); ui.toast("Render rate: " + b.dataset.fps + " fps"); });
  bind("btn-world", () => setView("world"));
  bind("btn-prev-corridor", () => enterCorridor((game.activeCorridor - 1 + fieldPlayer().corridorCount) % fieldPlayer().corridorCount));
  bind("btn-next-corridor", () => enterCorridor((game.activeCorridor + 1) % fieldPlayer().corridorCount));
  bind("quick-start-wave", () => cmd.startWave());
  bind("quick-speed-cycle", () => {
    if (game.gameMode === "solo") { game.speed = game.speed >= 3 ? 1 : game.speed + 1; ui.updateWavePanel(); }
    else if (game.lobby && game.lobby.host) { const ns = ((game.state.netSpeed || 1) >= 3) ? 1 : (game.state.netSpeed || 1) + 1; emit(C.setSpeed(game.me, ns)); ui.toast("Speed \u2192 \u00D7" + ns); }
    else ui.toast("Only the host can change speed");
  });
  bind("btn-settings-ingame", () => togglePause(true));
  bind("pause-resume", () => togglePause(false));
  bind("pause-restart", () => { if (game.gameMode !== "solo") { ui.toast("Restart is solo only"); return; } togglePause(false); startRun({ mode: game.mode, corridors: game.state.players[game.me].corridorCount, economy: game.state.economy, status: game.state.statusMode, gameMode: "solo", elements: game.state.players[game.me].elements }); });
  bind("pause-save", () => { autosave(); ui.toast("Run saved to this device"); });
  bind("pause-exit", () => { togglePause(false); showScreen("menu"); refreshMenu(); });
  bind("end-again", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); startRun({ mode: game.mode === "endless" ? "loop" : game.mode, corridors: game.state.players[game.me].corridorCount, economy: game.state.economy, status: game.state.statusMode, gameMode: "solo", elements: game.state.players[game.me].elements }); });
  bind("end-menu", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); showScreen("menu"); refreshMenu(); });
  bind("end-endless", () => { const sc = $("end-screen"); if (sc) sc.classList.remove("show"); game.state.players[game.me].phase = "build"; game.state.mode = "endless"; ui.toast("Endless Mode!"); });
  // ---- Save / Import / Export ----
  bind("sm-close", () => $("save-modal").classList.remove("show"));
  bind("sm-export-run", () => { const t = $("save-text"); if (t && SaveSystem) t.value = SaveSystem.exportRunText(serializeRun()); });
  bind("sm-export-meta", () => { const t = $("save-text"); if (t && SaveSystem) t.value = SaveSystem.exportMetaText(meta); });
  bind("sm-download", () => { if (SaveSystem) SaveSystem.downloadText(($("save-text").value) || SaveSystem.exportRunText(serializeRun()), "circle-tower-wars-save.json"); });
  bind("sm-upload", () => { const f = $("sm-file"); if (f) f.click(); });
  bind("sm-import", () => {
    const t = $("save-text"); if (!t || !SaveSystem) return;
    const res = SaveSystem.importText(t.value);
    if (!res.ok) { ui.toast("Import failed: " + res.error); return; }
    if (res.kind === "run") { restoreRun(res.data); $("save-modal").classList.remove("show"); ui.toast("Run imported!"); }
    else { meta = res.data; SaveSystem.saveMeta(meta); $("save-modal").classList.remove("show"); ui.toast("Progress imported!"); refreshMenu(); }
  });
  bind("sm-reset", () => { if (confirm("Reset ALL progress? This cannot be undone.")) { if (SaveSystem) SaveSystem.resetAll(); meta = SaveSystem ? SaveSystem.loadMeta() : { mastery: {} }; ui.toast("Progress reset"); refreshMenu(); } });
  const smFile = $("sm-file");
  if (smFile) smFile.onchange = (e) => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { const t = $("save-text"); if (t) t.value = rd.result; ui.toast("File loaded — press Import"); }; rd.readAsText(f); };

  // ---- Multiplayer lobby (Tier A: rooms, ready, feedback) ----
  bind("btn-create-room", () => mpCreateRoom());
  bind("btn-join-room", () => mpJoinRoom());
  bind("btn-show-room", () => alert(JSON.stringify(game.lobby && game.lobby.room, null, 2)));
  bind("btn-firebase-test", async () => { try { if (!window.CTWMultiplayer) return ui.toast("Multiplayer not loaded"); await window.CTWMultiplayer.createTestRoom("test-room"); ui.toast("Firebase write OK"); } catch (err) { ui.toast("Firebase error: " + err.message); } });
  bind("mp-lobby-close", () => $("multiplayer-lobby").classList.remove("show"));
  bind("mp-ready", () => mpToggleReady());
  bind("mp-start", () => mpStart());
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
function lobbyPlayerCount() { return (game.lobby && game.lobby.room && game.lobby.room.players) ? Object.keys(game.lobby.room.players).length : 0; }
function updateGameModeButtons() {
  const enabled = lobbyPlayerCount() >= 2;
  const locked = !!game.mpHosting; // match type fixed once configuring
  document.querySelectorAll("[data-gamemode]").forEach((b) => {
    const mp = b.dataset.gamemode !== "solo";
    b.classList.toggle("disabled", locked || (mp && !enabled));
    b.classList.toggle("sel", b.dataset.gamemode === setup.gameMode);
  });
}
function togglePause(force) {
  const o = $("pause-overlay");
  const want = force != null ? force : !(o && o.classList.contains("show"));
  if (o) o.classList.toggle("show", want);
  if (game.gameMode === "solo") game.paused = want; // multiplayer: never pause the shared sim
}

function fieldBottomInset() {
  const stage = $("game-stage"); if (!stage) return 12;
  const sr = stage.getBoundingClientRect(); let inset = 12;
  for (const id of ["build-menu", "tower-panel", "enemy-panel"]) {
    const pnl = $(id);
    if (pnl && pnl.classList.contains("show")) { const pr = pnl.getBoundingClientRect(); inset = Math.max(inset, sr.bottom - pr.top + 10); }
  }
  return inset;
}
function clampFieldCamera() {
  const cam = game.fieldCam; cam.zoom = Math.max(1, Math.min(4, cam.zoom));
  if (!game.state) return;
  const G = game.state.grid, W = renderer.cw(), H = renderer.ch();
  const top = fieldTopInset(), bottom = fieldBottomInset();
  const ts = ((W - 24) / G.cols) * cam.zoom;
  const gridW = ts * G.cols, gridH = ts * G.rows, visW = W - 24, visH = H - top - bottom;
  if (gridW <= visW) cam.x = (visW - gridW) / 2;
  else cam.x = Math.max(visW - gridW, Math.min(0, cam.x));
  const minY = Math.min(0, visH - gridH);
  cam.y = Math.max(minY, Math.min(0, cam.y));
}
function zoomFieldAt(sx, sy, newZoom) {
  const before = renderer.fieldGeom(view);
  const gx = (sx - before.ox) / before.ts, gy = (sy - before.oy) / before.ts;
  game.fieldCam.zoom = Math.max(1, Math.min(4, newZoom));
  const after = renderer.fieldGeom(view);
  game.fieldCam.x += sx - (after.ox + gx * after.ts);
  game.fieldCam.y += sy - (after.oy + gy * after.ts);
  clampFieldCamera();
}
function bindTouch() {
  let tch = null;
  canvas.addEventListener("wheel", (ev) => {
    if (game.screen !== "game" || game.view !== "field") return; ev.preventDefault();
    const rect = canvas.getBoundingClientRect(), px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (ev.ctrlKey) zoomFieldAt(px, py, game.fieldCam.zoom * (ev.deltaY < 0 ? 1.1 : 0.9));
    else { game.fieldCam.y -= ev.deltaY; clampFieldCamera(); }
  }, { passive: false });
  canvas.addEventListener("touchstart", (ev) => {
    if (game.screen !== "game" || game.view !== "field") return;
    if (ev.touches.length === 1) tch = { mode: "pan", x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    if (ev.touches.length === 2) { const a = ev.touches[0], b = ev.touches[1]; tch = { mode: "pinch", dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: game.fieldCam.zoom }; }
  }, { passive: false });
  canvas.addEventListener("touchmove", (ev) => {
    if (game.screen !== "game" || game.view !== "field" || !tch) return; ev.preventDefault();
    if (tch.mode === "pan" && ev.touches.length === 1) { const t = ev.touches[0]; game.fieldCam.x += t.clientX - tch.x; game.fieldCam.y += t.clientY - tch.y; tch.x = t.clientX; tch.y = t.clientY; clampFieldCamera(); }
    if (tch.mode === "pinch" && ev.touches.length === 2) {
      const a = ev.touches[0], b = ev.touches[1], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const rect = canvas.getBoundingClientRect(), mx = (a.clientX + b.clientX) / 2 - rect.left, my = (a.clientY + b.clientY) / 2 - rect.top;
      zoomFieldAt(mx, my, tch.zoom * (d / tch.dist));
    }
  }, { passive: false });
  canvas.addEventListener("touchend", () => { tch = null; }, { passive: false });
}

// ---- Multiplayer lobby helpers (Tier A) ----
function mpId() { return "p_" + Math.random().toString(36).slice(2, 8); }
function openLobby() { const m = $("multiplayer-lobby"); if (m) m.classList.add("show"); ui.renderMultiplayerLobby(game.lobby); }
function handleRoomUpdate(room) {
  if (!game.lobby) return;
  game.lobby.room = room;
  ui.renderMultiplayerLobby(game.lobby);
  updateGameModeButtons();
  if (room && room.status === "configuring" && !game.lobby.host && game.screen !== "game" && !game.lobby._cfgNoted) {
    game.lobby._cfgNoted = true; ui.toast("Host is configuring the match…");
  }
  if (room && room.status === "running" && room.match && !game.lobby.started) {
    game.lobby.started = true;
    startMultiplayerMatch(room.match);
  }
}
async function mpCreateRoom() {
  if (!window.CTWMultiplayer) return ui.toast("Multiplayer not loaded yet");
  const roomId = prompt("Room code:", "ctw-" + Math.random().toString(36).slice(2, 6)); if (!roomId) return;
  const modeIn = (prompt("Match type: 'competitive' or 'coop'", "competitive") || "competitive").toLowerCase();
  const hostMode = modeIn === "coop" ? "coop" : "competitive";
  const playerId = mpId();
  try {
    await window.CTWMultiplayer.createRoom(roomId, playerId, { codeVersion: DB.codeVersion, contentHash: DB.contentHash });
    game.lobby = { roomId, playerId, room: null, host: true, hostMode: hostMode, started: false };
    window.CTWMultiplayer.watchRoom(roomId, handleRoomUpdate);
    openLobby(); ui.toast("Room created: " + roomId + " (" + hostMode + ")");
  } catch (err) { ui.toast("Create failed: " + err.message); }
}
async function mpJoinRoom() {
  if (!window.CTWMultiplayer) return ui.toast("Multiplayer not loaded yet");
  const roomId = prompt("Room code:", "ctw-test"); if (!roomId) return;
  const playerId = mpId();
  try {
    await window.CTWMultiplayer.joinRoom(roomId, playerId);
    game.lobby = { roomId, playerId, room: null, host: false, started: false };
    window.CTWMultiplayer.watchRoom(roomId, handleRoomUpdate);
    openLobby(); ui.toast("Joined room: " + roomId);
  } catch (err) { ui.toast("Join failed: " + err.message); }
}
async function mpToggleReady() {
  const L = game.lobby; if (!L || !L.room || !L.room.players || !L.room.players[L.playerId]) return;
  const cur = !!L.room.players[L.playerId].ready;
  try { await window.CTWMultiplayer.setReady(L.roomId, L.playerId, !cur); } catch (err) { ui.toast(err.message); }
}
async function mpStart() {
  const L = game.lobby; if (!L || !L.room || L.room.host !== L.playerId) return;
  const entries = Object.entries(L.room.players || {});
  if (!(entries.length >= 2 && entries.every(([, p]) => p.ready))) { ui.toast("Need at least 2 players, all ready."); return; }
  // Go to the config screen; the host picks mode/corridors/economy, then Begin Run.
  game.mpHosting = true;
  setup.gameMode = L.hostMode || "competitive";
  try { await window.CTWMultiplayer.setRoomStatus(L.roomId, "configuring"); } catch (e) {}
  const lob = $("multiplayer-lobby"); if (lob) lob.classList.remove("show");
  openSetup();
  ui.toast("Configure the match, then press Begin Run");
}

// Host builds the match config from the setup screen and launches for everyone.
async function beginMultiplayerMatch() {
  const L = game.lobby; if (!L || !L.room) { ui.toast("Lobby lost"); return; }
  const entries = Object.entries(L.room.players || {});
  entries.sort((a, b) => ((a[1].slot != null ? a[1].slot : 99) - (b[1].slot != null ? b[1].slot : 99)) || ((a[1].joinedAt || 0) - (b[1].joinedAt || 0)));
  const order = entries.map(([id]) => id);
  const corridorCount = setup.mode === "single" ? 1 : setup.corridors;
  const match = {
    seed: (Math.random() * 1e9) | 0,
    gameMode: L.hostMode || "competitive",
    mode: setup.mode, corridorCount: corridorCount,
    elements: setup.elements.slice(0, corridorCount),
    economy: setup.economy, statusMode: setup.status,
    order: order, startedAt: Date.now(),
  };
  game.mpHosting = false;
  try { await window.CTWMultiplayer.setMatchStart(L.roomId, match); } catch (err) { ui.toast("Start failed: " + err.message); game.mpHosting = true; }
}

function startMultiplayerMatch(match) {
  const myIdx = match.order.indexOf(game.lobby.playerId);
  if (myIdx < 0) { ui.toast("You are not part of this match."); return; }
  const playerCount = match.order.length;
  const players = match.order.map(() => ({ corridorCount: match.corridorCount, elements: match.elements.slice(0, match.corridorCount) }));
  const cfg = { seed: match.seed, mode: match.mode, gameMode: match.gameMode, economy: match.economy, statusMode: match.statusMode, players };
  game.state = createState(bal, cfg);
  game.gameMode = match.gameMode; game.mode = match.mode; game.me = myIdx;
  game.speed = 1; game.clock = 0; game.view = "world"; game.activeCorridor = 0;
  game.fieldCam = { x: 0, y: 0, zoom: 1 }; view.fieldCam = game.fieldCam;
  game.selectedTowerId = game.selectedEnemyId = game.buildTile = null;
  const transport = window.CTWMultiplayer.makeTransport(game.lobby.roomId, myIdx);
  game.lockstep = createLockstep({
    state: game.state, SIM_DT, transport, localPlayer: myIdx, playerCount: playerCount,
    onStep: (st) => afterTick(st),
    onStall: (missing) => showBanner("Waiting for player " + missing.map((i) => i + 1).join(", ") + "…"),
    onResume: () => hideBanner(),
    onDesync: (d) => { console.warn("DESYNC", d); ui.toast("Desync detected (tick " + d.tick + ")"); },
  });
  game.driver = makeNetDriver(game.state, game.lockstep);
  game.lockstep.start();
  const lob = $("multiplayer-lobby"); if (lob) lob.classList.remove("show");
  showScreen("game"); resize();
  ui.closeAllPanels(); setView("world", true);
  ui.updateTopBar(); ui.updateEnemyOverview(); ui.updateWavePanel();
  setupSendButton();
  ui.toast(match.gameMode === "coop" ? "Co-op match started!" : "Competitive match started!");
}

function showBanner(msg) { const b = $("mp-banner"); if (b) { b.textContent = msg; b.classList.add("show"); } }
function hideBanner() { const b = $("mp-banner"); if (b) b.classList.remove("show"); }

let sendBtn = null;
function setupSendButton() {
  const wrap = $("quick-wave-controls"); if (!wrap) return;
  if (!sendBtn) { sendBtn = document.createElement("button"); sendBtn.id = "mp-send"; sendBtn.className = "btn"; sendBtn.textContent = "⚔ Send"; sendBtn.onclick = doSend; wrap.appendChild(sendBtn); }
  sendBtn.style.display = (game.gameMode === "competitive") ? "" : "none";
}
function doSend() {
  if (game.gameMode !== "competitive" || !game.state) return;
  const n = game.state.players.length;
  for (let i = 1; i < n; i++) { const idx = (game.me + i) % n; if (game.state.players[idx].alive) { cmd.send(idx, "grunt"); ui.toast("Sent a grunt to Player " + (idx + 1)); return; } }
}

function preventBrowserGestures() {
  let lastEnd = 0;
  document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastEnd <= 300) e.preventDefault(); lastEnd = now; }, { passive: false });
  ["gesturestart", "gesturechange", "gestureend"].forEach((g) => document.addEventListener(g, (e) => e.preventDefault(), { passive: false }));
}

function registerServiceWorker() {
  // Service worker temporarily DISABLED during active development: it was caching
  // old module files and hiding updates. We actively unregister any existing SW
  // and clear its caches so every load fetches fresh files. Re-enable for offline
  // play once the game is stable (replace this body with navigator.serviceWorker.register("sw.js")).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
  if (window.caches && caches.keys) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

export default { boot };
