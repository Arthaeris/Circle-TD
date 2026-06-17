/* =============================================================================
 * Circle Tower Wars — ui/shell.js
 * UI LAYER (panels, menus, HUD, toasts). Builds DOM and wires buttons to
 * COMMAND callbacks supplied by app/main.js — it never mutates sim state; user
 * intent becomes commands that flow through the (lockstep) tick layer (§2/§6).
 *
 * Reads from the sim state to display values (fixed-point converted to ints for
 * display only). In-game text is English (per request).
 * ===========================================================================*/
import * as fx from "../sim/fx.js";

const $ = (id) => document.getElementById(id);
const toI = (v) => fx.toInt(v);

export function createUI(opts) {
  const DB = opts.DB;
  const getView = opts.getView;       // () => view {state, me, player, view, activeCorridor, ...}
  const cmd = opts.cmd;               // command emitters {build, sell, upgrade, mutate, startWave, send}
  const masteryLevel = opts.masteryLevel || (() => 5);
  const getMeta = opts.getMeta || (() => ({ mastery: {}, elementWins: {} }));

  let toastT = null;
  function toast(msg) { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600); }
  function setText(id, t) { const e = $(id); if (e) e.textContent = t; }

  function closeAllPanels() {
    ["build-menu", "tower-panel", "enemy-panel"].forEach((id) => { const e = $(id); if (e) e.classList.remove("show"); });
    const v = getView(); v.selectedTowerId = null; v.selectedEnemyId = null; v.buildTile = null; v.buildMenuOpen = false;
  }

  // ---- HUD -----------------------------------------------------------------
  function updateTopBar() {
    const v = getView(), pl = v.player;
    setText("lives", (v.state.gameMode === "coop" ? v.state.coopLives : pl.lives) + "/" + pl.maxLives);
    if (v.state.economy === "shared") setText("currency-display", "🪙 " + Math.floor(pl.gold));
    else { const cur = pl.elements[v.view === "field" ? v.activeCorridor : 0]; setText("currency-display", DB.ELEMENTS[cur].icon + " " + Math.floor(pl.essence[cur])); }
    const fld = v.field || pl;
    setText("wave-display", "Wave " + (v.state.mode === "endless" ? fld.wave : (fld.wave + "/" + fld.totalWaves)));
    const m = Math.floor(v.time / 60), s = Math.floor(v.time % 60);
    setText("match-time", (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s);
  }

  function updateEnemyOverview() {
    const ov = $("enemy-overview"); if (!ov) return;
    const v = getView(), fld = v.field;
    let html = `<div class="ov-head">Survivors by Origin</div>`;
    for (let i = 0; i < fld.corridorCount; i++) {
      const el = DB.ELEMENTS[fld.elements[i]];
      let alive = 0; for (const e of v.state.enemies) if (e.owner === v.fieldId && e.originIndex === i) alive++;
      const total = fld.corridors[i].spawnedTotal, pct = total ? alive / total : 0;
      html += `<div class="ov-row" data-ci="${i}"><span class="ov-el" style="color:${el.color}">${el.icon} ${el.name}</span><span class="ov-num">${alive}/${total}</span><div class="ov-bar"><div style="width:${pct * 100}%;background:${el.color}"></div></div></div>`;
    }
    ov.innerHTML = html;
    ov.querySelectorAll(".ov-row").forEach((r) => r.onclick = () => opts.enterCorridor(+r.dataset.ci));
  }

  function updateWavePanel() {
    const v = getView(), pl = v.field;
    let label = "▶ Start Wave " + (pl.wave + 1);
    if (v.state.mode !== "endless" && pl.wave >= pl.totalWaves && pl.phase !== "prep") label = "Clear Enemies";
    if (pl.phase === "prep") label = "Summon Boss";
    if (pl.phase === "endboss") label = "Boss Active";
    const b = $("quick-start-wave");
    if (b) { b.textContent = label; b.classList.toggle("disabled", pl.phase === "endboss"); }
    const sb = $("quick-speed-cycle"); if (sb) sb.textContent = "×" + v.speed;
  }

  // ---- build menu ----------------------------------------------------------
  function openBuildMenu(corr, tile) {
    closeAllPanels();
    const v = getView(); v.buildTile = tile; v.buildMenuOpen = true;
    const el = DB.ELEMENTS[corr.element];
    const slots = DB.unlockedTowerSlots(masteryLevel(corr.element));
    const list = DB.TOWERS.filter((t) => t.element === corr.element && t.slot < slots);
    const menu = $("build-menu");
    const cur = v.state.economy === "shared" ? v.player.gold : v.player.essence[corr.element];
    menu.innerHTML = `<div class="panel-head">${el.icon} Build — ${el.name} <span class="cur">${Math.floor(cur)} ${v.state.economy === "shared" ? "G" : el.currency.split(" ")[0]}</span></div>`;
    const grid = document.createElement("div"); grid.className = "build-grid";
    list.forEach((t) => {
      const b = document.createElement("button"); b.className = "build-card"; b.style.setProperty("--ec", el.color);
      if (cur < t.cost) b.classList.add("cant");
      b.innerHTML = `<div class="bc-name">${t.name}</div><div class="bc-arch">${t.archetype}</div><div class="bc-stats">⚔ ${t.damage} · ◎ ${t.range.toFixed(1)} · ⚡ ${t.fireRate}</div>${t.status ? `<div class="bc-eff">${DB.STATUSES[t.status].icon} ${DB.STATUSES[t.status].name}</div>` : ""}<div class="bc-cost">${t.cost}</div>`;
      b.onclick = () => { cmd.build(corr.index, tile.c, tile.r, t.id); closeAllPanels(); };
      grid.appendChild(b);
    });
    menu.appendChild(grid);
    const close = document.createElement("button"); close.className = "panel-close"; close.textContent = "✕"; close.onclick = closeAllPanels; menu.appendChild(close);
    menu.classList.add("show");
  }

  // ---- tower panel ---------------------------------------------------------
  function openTowerPanel(corr, tw) {
    closeAllPanels();
    const v = getView(); v.selectedTowerId = tw.id;
    const el = DB.ELEMENTS[tw.def.element], def = DB.TOWER_BY_ID[tw.def.id];
    const maxed = tw.level >= DB.CONFIG.maxLevel;
    const cost = Math.round(def.cost * DB.SCALING.upgradeCostBase * Math.pow(DB.SCALING.costGrowth, tw.level - 1));
    const slots = DB.mutationSlotsAvailable(masteryLevel(tw.def.element));
    const expNeed = tw.expert < 5 ? DB.CONFIG.expertThresholds[tw.expert] : tw.kills;
    const expPct = tw.expert < 5 ? Math.min(1, tw.kills / expNeed) : 1;
    const cur = towerView(def, tw.level, tw.expert);
    const nxt = maxed ? null : towerView(def, tw.level + 1, tw.expert);
    let html = `<button class="panel-close" id="tp-close">✕</button>
      <div class="tp-head" style="--ec:${el.color}"><span class="tp-icon">${el.icon}</span><div><div class="tp-name">${def.name}</div><div class="tp-sub">${el.name} · ${def.archetype}</div></div></div>
      <div class="tp-levels"><span class="badge">Lv ${tw.level}/10</span><span class="badge gold">Expert ${tw.expert}/5</span></div>
      <div class="exp-bar"><div style="width:${expPct * 100}%"></div></div>
      <div class="exp-label">${tw.expert < 5 ? tw.kills + " / " + expNeed + " kills" : "MAX EXPERTISE"} · ${tw.kills} total kills</div>
      <div class="tp-stats">
        ${statRow("Damage", cur.dmg.toFixed(0), nxt && nxt.dmg.toFixed(0))}
        ${statRow("Range", cur.range.toFixed(1), nxt && nxt.range.toFixed(1))}
        ${statRow("Atk Speed", cur.rate.toFixed(2), nxt && nxt.rate.toFixed(2))}
        ${def.status ? `<div class="tp-eff">${DB.STATUSES[def.status].icon} Applies ${DB.STATUSES[def.status].name}</div>` : ""}
      </div>
      <div class="tp-actions">
        <button id="tp-upgrade" class="${maxed ? "disabled" : ""}">${maxed ? "MAX LEVEL" : "Upgrade · " + cost}</button>
        <button id="tp-sell" class="sell">Sell</button>
      </div>`;
    if (maxed) {
      html += `<div class="tp-mut-head">Mutations ${slots ? `(${tw.mutations.length}/${slots} slots)` : "(locked — raise Mastery)"}</div><div class="tp-muts">`;
      def.mutations.forEach((m) => { const have = tw.mutations.includes(m.id); html += `<button class="mut-card ${have ? "have" : ""}" data-mut="${m.id}"><div class="mut-name">${m.name}</div><div class="mut-desc">${m.desc}</div></button>`; });
      html += `</div>`;
    } else html += `<div class="tp-mut-head dim">Mutations unlock at max level</div>`;
    const p = $("tower-panel"); p.innerHTML = html; p.classList.add("show");
    $("tp-close").onclick = closeAllPanels;
    $("tp-upgrade").onclick = () => { if (!maxed) cmd.upgrade(corr.index, tw.id); };
    $("tp-sell").onclick = () => { cmd.sell(corr.index, tw.id); closeAllPanels(); };
    p.querySelectorAll("[data-mut]").forEach((b) => b.onclick = () => cmd.mutate(corr.index, tw.id, b.dataset.mut));
  }
  function statRow(label, val, next) { return `<div class="stat-row"><span>${label}</span><span>${val}${(next != null && String(next) !== String(val)) ? ` <em>\u2192 ${next}</em>` : ""}</span></div>`; }
  // display-only stat projection (mirrors core scaling: per-level + expert bonus)
  function towerView(def, level, expert) {
    const S = DB.SCALING, C = DB.CONFIG;
    const dmg = def.damage * Math.pow(1 + S.damagePerLevel, level - 1) * (1 + (C.expertDamageBonus[expert] || 0));
    const rate = def.fireRate * Math.pow(1 + S.fireRatePerLevel, level - 1);
    const range = def.range + S.rangePerLevel * (level - 1);
    return { dmg, rate, range };
  }

  // ---- enemy panel ---------------------------------------------------------
  function openEnemyPanel(e) {
    closeAllPanels();
    const v = getView(); v.selectedEnemyId = e.id;
    const oel = DB.ELEMENTS[v.player.elements[e.originIndex]];
    const stk = (e.statusKeys || []).map((k) => DB.STATUSES[k]).filter(Boolean);
    const p = $("enemy-panel");
    p.innerHTML = `<button class="panel-close" id="ep-close">✕</button>
      <div class="ep-head">${e.boss ? "☠ " : ""}${e.def.id}${e.end ? " (END BOSS)" : ""}${e.sent ? " · SENT" : ""}</div>
      <div class="exp-bar big"><div style="width:${Math.min(1, Math.max(0, e.hp) / e.maxHp) * 100}%;background:#ff4d6d"></div></div>
      <div class="exp-label">${Math.max(0, toI(e.hp))} / ${toI(e.maxHp)} HP</div>
      <div class="tp-stats">${statRow("Origin", oel.icon + " " + oel.name)}${statRow("Loops", e.loopCount)}${statRow("Armor", toI(e.armor))}${statRow("Reward", e.reward)}</div>
      <div class="ep-status">${stk.length ? stk.map((s) => `<span class="stag" style="--sc:${s.color}">${s.icon} ${s.name}</span>`).join("") : "<span class='dim'>No status</span>"}</div>`;
    p.classList.add("show");
    $("ep-close").onclick = closeAllPanels;
  }

  // ---- live panel refresh (tower stats / enemy hp+status update in place) ----
  function refreshPanels() {
    const v = getView(); if (!v.state) return;
    if (v.selectedTowerId) {
      let found = null, fcorr = null;
      for (const c of v.player.corridors) { const t = c.towers.find((t) => t.id === v.selectedTowerId); if (t) { found = t; fcorr = c; break; } }
      if (found) openTowerPanel(fcorr, found); else closeAllPanels();
    } else if (v.selectedEnemyId) {
      const e = v.state.enemies.find((e) => e.id === v.selectedEnemyId && e.owner === v.me);
      if (e && e.alive) openEnemyPanel(e); else closeAllPanels();
    }
  }

  // ---- setup screen --------------------------------------------------------
  function renderSetup(setup, availElements) {
    document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("sel", b.dataset.mode === setup.mode));
    const cc = $("corridor-buttons");
    if (cc && !cc.dataset.built) {
      cc.innerHTML = ""; DB.CORRIDOR_OPTIONS.forEach((n) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = n; b.dataset.cn = n; b.onclick = () => { if (setup.mode === "single") return; setup.corridors = n; renderSetup(setup, availElements); }; cc.appendChild(b); }); cc.dataset.built = "1";
    }
    if (cc) cc.querySelectorAll(".chip").forEach((b) => { b.classList.toggle("sel", +b.dataset.cn === setup.corridors); b.classList.toggle("disabled", setup.mode === "single"); });
    const shape = $("shape-name"); if (shape) shape.textContent = DB.SHAPE_NAMES[setup.corridors] || "";
    if (setup.mode === "single") setup.corridors = 1;
    document.querySelectorAll("[data-econ]").forEach((b) => b.classList.toggle("sel", b.dataset.econ === setup.economy));
    document.querySelectorAll("[data-status]").forEach((b) => b.classList.toggle("sel", b.dataset.status === setup.status));
    const wrap = $("element-assign");
    if (wrap) {
      wrap.innerHTML = ""; const n = setup.mode === "single" ? 1 : setup.corridors;
      for (let i = 0; i < n; i++) {
        if (!availElements.includes(setup.elements[i])) setup.elements[i] = availElements[i % availElements.length];
        const row = document.createElement("div"); row.className = "assign-row";
        const lbl = document.createElement("div"); lbl.className = "assign-lbl"; lbl.textContent = "Corridor " + (i + 1); row.appendChild(lbl);
        const optsEl = document.createElement("div"); optsEl.className = "assign-opts";
        availElements.forEach((eid) => { const el = DB.ELEMENTS[eid]; const b = document.createElement("button"); b.className = "elbtn"; b.style.setProperty("--ec", el.color); b.innerHTML = `<span>${el.icon}</span>${el.name}`; b.classList.toggle("sel", setup.elements[i] === eid); b.onclick = () => { setup.elements[i] = eid; renderSetup(setup, availElements); }; optsEl.appendChild(b); });
        row.appendChild(optsEl); wrap.appendChild(row);
      }
    }
    drawShapePreview(setup);
  }

  // ---- setup preview (shape polygon + chosen element icons) ----------------
  function drawShapePreview(setup) {
    const c = $("preview-canvas"); if (!c) return;
    const x = c.getContext("2d");
    const W = c.width = c.clientWidth * 2, H = c.height = c.clientHeight * 2;
    x.clearRect(0, 0, W, H);
    const n = setup.mode === "single" ? 1 : setup.corridors;
    const pts = DB.polygonPoints(n);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36;
    x.lineWidth = 4; x.strokeStyle = "rgba(255,255,255,.25)";
    if (n > 1) {
      x.beginPath();
      pts.forEach((p, i) => { const px = cx + p.x * R, py = cy + p.y * R; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.closePath(); x.stroke();
    }
    pts.forEach((p, i) => {
      const px = cx + p.x * R, py = cy + p.y * R;
      const el = DB.ELEMENTS[setup.elements[i]] || DB.ELEMENTS.fire;
      x.beginPath(); x.arc(px, py, 22, 0, 7); x.fillStyle = el.color; x.fill();
      x.fillStyle = "#0d0f1a"; x.font = "26px serif"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(el.icon, px, py + 1);
    });
    if (n === 1) { x.fillStyle = "rgba(255,255,255,.4)"; x.font = "20px sans-serif"; x.fillText("Single Lane", cx, cy + 50); }
  }

  // ---- mastery screen ------------------------------------------------------
  function openMastery() {
    const m = $("mastery-screen"); if (!m) return;
    const meta = getMeta();
    const avail = DB.availableElements(meta.mastery || {});
    let html = `<button class="panel-close" id="ms-close">✕</button><h2>Elemental Mastery</h2><div class="mastery-grid">`;
    DB.ELEMENT_ORDER.forEach((eid) => {
      const el = DB.ELEMENTS[eid];
      const lvl = (meta.mastery && meta.mastery[eid]) || 0;
      const wins = (meta.elementWins && meta.elementWins[eid]) || 0;
      const locked = !avail.includes(eid);
      const nextReq = lvl >= 5 ? "MAX" : lvl === 4 ? "Reach Wave 100" : `Win ${DB.MASTERY.winsRequired[lvl + 1]} runs`;
      html += `<div class="mastery-card ${locked ? "locked" : ""}" style="--ec:${el.color}">
        <div class="mc-head">${el.icon} ${el.name} ${locked ? "🔒" : ""}</div>
        <div class="mc-lvl">Mastery ${lvl}/5</div>
        <div class="mc-pips">${[1,2,3,4,5].map(i => `<span class="${i <= lvl ? "on" : ""}"></span>`).join("")}</div>
        <div class="mc-req">${locked ? unlockHint(eid) : nextReq}</div>
        <div class="mc-wins">Wins with element: ${wins}</div></div>`;
    });
    html += `</div>`;
    m.innerHTML = html; m.classList.add("show");
    $("ms-close").onclick = () => m.classList.remove("show");
  }
  function unlockHint(eid) {
    if (eid === "light" || eid === "darkness") return "Unlock: all starters at Mastery 1";
    if (eid === "mech" || eid === "abnormal") return "Unlock: any element at Mastery 5";
    return "";
  }

  // ---- multiplayer lobby ---------------------------------------------------
  function renderMultiplayerLobby(mp) {
    const box = $("mp-player-list");
    const code = $("mp-room-code"); if (code) code.textContent = (mp && mp.roomId) || "---";
    if (!box) return;
    const room = mp && mp.room;
    if (!room || !room.players) { box.innerHTML = `<p class="dim">Waiting for room data...</p>`; return; }
    const players = Object.entries(room.players);
    box.innerHTML = players.map(([id, p], i) => {
      const me = id === mp.playerId ? " — You" : "";
      const host = room.host === id ? " 👑" : "";
      const ready = p.ready ? "✅ Ready" : "⏳ Not ready";
      return `<div class="end-stat"><span>Player ${i + 1}${host}${me}</span><b>${ready}</b></div>`;
    }).join("");
    const startBtn = $("mp-start");
    if (startBtn) startBtn.style.display = room.host === mp.playerId ? "block" : "none";
  }

  return { toast, setText, closeAllPanels, updateTopBar, updateEnemyOverview, updateWavePanel, openBuildMenu, openTowerPanel, openEnemyPanel, renderSetup, drawShapePreview, openMastery, renderMultiplayerLobby, refreshPanels };
}

export default { createUI };
