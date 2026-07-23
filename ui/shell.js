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
import { generateWave, waveAffix, AFFIXES } from "../sim/waves.js";

const $ = (id) => document.getElementById(id);
const toI = (v) => fx.toInt(v);

export function createUI(opts) {
  const DB = opts.DB;
  const getView = opts.getView;       // () => view {state, me, player, view, activeCorridor, ...}
  const cmd = opts.cmd;               // command emitters {build, sell, upgrade, mutate, startWave, send}
  const masteryLevel = opts.masteryLevel || (() => 5);
  const getMeta = opts.getMeta || (() => ({ mastery: {}, elementWins: {} }));
  let _twSig = null; // tower-panel content signature (avoid rebuilding every refresh)
  let _sendSig = null; // send-panel content signature

  // Stacked toast queue: consecutive messages no longer overwrite each other.
  // #toast is a container; each message is a child that fades out on its own.
  const TOAST_MAX = 3, TOAST_MS = 2600;
  function toast(msg) {
    const t = $("toast"); if (!t) return;
    while (t.children.length >= TOAST_MAX) t.removeChild(t.firstChild);
    const m = document.createElement("div"); m.className = "toast-msg"; m.textContent = msg;
    t.appendChild(m);
    requestAnimationFrame(() => m.classList.add("show"));
    setTimeout(() => { m.classList.remove("show"); setTimeout(() => m.remove(), 300); }, TOAST_MS);
  }
  function setText(id, t) { const e = $(id); if (e) e.textContent = t; }

  function closeAllPanels() {
    ["build-menu", "tower-panel", "enemy-panel", "send-panel"].forEach((id) => { const e = $(id); if (e) e.classList.remove("show"); });
    closeRing();
    const v = getView(); v.selectedTowerId = null; v.selectedEnemyId = null; v.buildTile = null; v.buildMenuOpen = false; v.buildPreview = null;
    _sendSig = null;
  }

  // ---------------------------------------------------------------------------
  // RADIAL MENUS — build & tower actions bloom around the tapped tile.
  // Mouse: hover previews, click executes. Touch: first tap focuses/previews,
  // second tap executes (confirm pattern). The ring lives in #radial-menu,
  // an overlay on the game stage; anything else closes it.
  // ---------------------------------------------------------------------------
  let _ring = null;
  function closeRing() {
    const m = $("radial-menu"); if (m) { m.classList.remove("show"); m.innerHTML = ""; }
    _ring = null;
  }
  function showRing(sx, sy, items, opts) {
    const m = $("radial-menu"), stage = $("game-stage"); if (!m || !stage) return;
    m.innerHTML = "";
    const W = stage.clientWidth, H = stage.clientHeight, R = 78;
    const cx = Math.max(R + 36, Math.min(W - R - 36, sx));
    const cy = Math.max(R + 70, Math.min(H - R - 40, sy));
    const label = document.createElement("div");
    label.className = "rad-label";
    label.style.left = cx + "px"; label.style.top = (cy - R - 36) + "px";
    label.innerHTML = opts.title || "";
    m.appendChild(label);
    _ring = { items: {}, focus: null, label, defTitle: opts.title || "" };
    const n = items.length;
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const b = document.createElement("button");
      b.className = "rad-item" + (it.cls ? " " + it.cls : "");
      if (it.color) b.style.setProperty("--ec", it.color);
      b.style.left = (cx + Math.cos(a) * R) + "px";
      b.style.top = (cy + Math.sin(a) * R) + "px";
      const render = () => { b.innerHTML = typeof it.html === "function" ? it.html() : it.html; if (it.isDisabled) b.classList.toggle("cant", !!it.isDisabled()); };
      render();
      const focus = () => {
        if (_ring.focus && _ring.items[_ring.focus]) _ring.items[_ring.focus].el.classList.remove("focus");
        _ring.focus = it.key; b.classList.add("focus");
        if (it.onFocus) it.onFocus();
        label.innerHTML = it.focusHtml ? (typeof it.focusHtml === "function" ? it.focusHtml() : it.focusHtml) : _ring.defTitle;
      };
      b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { if (it.onFocus) it.onFocus(); if (it.confirm) focus(); } });
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (it.isDisabled && it.isDisabled()) return;
        if (it.confirm && (!_ring || _ring.focus !== it.key)) { focus(); return; } // touch: tap again to confirm
        it.exec();
        if (_ring) render();
      };
      _ring.items[it.key] = { el: b, render };
      m.appendChild(b);
    });
    m.classList.add("show");
  }
  function refreshRing() { if (!_ring) return; for (const k in _ring.items) _ring.items[k].render(); }

  // Build ring: one bubble per unlocked tower of the corridor's element.
  function openBuildRing(corr, tile, sx, sy) {
    closeAllPanels();
    const v = getView(); v.buildTile = tile; v.buildMenuOpen = true;
    const el = DB.ELEMENTS[corr.element];
    const slots = DB.unlockedTowerSlots(masteryLevel(corr.element));
    const list = DB.TOWERS.filter((t) => t.element === corr.element && t.slot < slots);
    const cur = () => v.state.economy === "shared" ? v.player.gold : v.player.essence[corr.element];
    const items = list.map((t) => ({
      key: t.id, color: el.color, confirm: true,
      html: `<span class="ri-ico">${el.icon}</span><span class="ri-cost">${t.cost}</span>`,
      focusHtml: () => {
        const dps = t.archetype === "support" ? "" : ` · ${Math.round(t.damage * t.fireRate)} DPS`;
        const st = t.status ? ` · ${DB.STATUSES[t.status].icon} ${DB.STATUSES[t.status].name}` : "";
        return `<b>${t.name}</b> — ${t.cost}g${dps}${st}<br><span class="rl-dim">${t.archetype} · tap again to build</span>`;
      },
      onFocus: () => { v.buildPreview = { range: t.range }; },
      exec: () => { cmd.build(corr.index, tile.c, tile.r, t.id); closeAllPanels(); },
      isDisabled: () => cur() < t.cost,
    }));
    items.push({ key: "x", cls: "rad-cancel", confirm: false, html: "✕", exec: closeAllPanels });
    showRing(sx, sy, items, { title: `${el.icon} Build — ${Math.floor(cur())}g` });
  }

  // Tower ring: upgrade / sell / target cycle / details.
  function openTowerRing(corr, tw, sx, sy) {
    closeAllPanels();
    const v = getView(); v.selectedTowerId = tw.id; // renderer draws the range circle
    const el = DB.ELEMENTS[tw.def.element], def = DB.TOWER_BY_ID[tw.def.id];
    const gold = () => v.state.economy === "shared" ? v.player.gold : v.player.essence[def.element];
    const upCost = () => Math.round(def.cost * DB.SCALING.upgradeCostBase * Math.pow(DB.SCALING.costGrowth, tw.level - 1));
    const maxed = () => tw.level >= DB.CONFIG.maxLevel;
    const TM = ["first", "last", "strong", "weak"];
    const items = [
      { key: "up", color: el.color, confirm: false,
        html: () => maxed() ? `<span class="ri-ico">★</span><span class="ri-cost">MAX</span>` : `<span class="ri-ico">⬆</span><span class="ri-cost">${upCost()}</span>`,
        isDisabled: () => maxed() || gold() < upCost(),
        exec: () => { if (!maxed()) cmd.upgrade(corr.index, tw.id); } },
      { key: "tgt", confirm: false,
        html: () => `<span class="ri-ico">🎯</span><span class="ri-cost">${tw.targetMode || "first"}</span>`,
        exec: () => { const m = TM[(TM.indexOf(tw.targetMode || "first") + 1) % TM.length]; cmd.setTarget(corr.index, tw.id, m); } },
      { key: "info", confirm: false, html: `<span class="ri-ico">ℹ</span><span class="ri-cost">info</span>`,
        exec: () => openTowerPanel(corr, tw) },
      { key: "sell", cls: "rad-sell", confirm: true,
        html: `<span class="ri-ico">💰</span><span class="ri-cost">+${sellRefund(def, tw.level)}</span>`,
        focusHtml: () => `<b>Sell for +${sellRefund(def, tw.level)}g</b><br><span class="rl-dim">tap again to confirm</span>`,
        exec: () => { cmd.sell(corr.index, tw.id); closeAllPanels(); } },
      { key: "x", cls: "rad-cancel", confirm: false, html: "✕", exec: closeAllPanels },
    ];
    showRing(sx, sy, items, { title: `${el.icon} ${def.name} · Lv${tw.level}${maxed() ? " · mutations in ℹ" : ""}` });
  }

  // ---- synergy helpers (display-only views over DB.SYNERGIES) ---------------
  function synergyEffectText(syn) {
    const parts = [];
    if (syn.burst) parts.push(syn.burst + " burst dmg");
    if (syn.dotMult) parts.push("×" + syn.dotMult + " poison dmg");
    if (syn.curseBoost) parts.push("×" + syn.curseBoost + " curse dmg");
    if (syn.execute) parts.push("executes below " + Math.round(syn.execute * 100) + "% HP");
    if (syn.spread) parts.push("spreads statuses to nearby enemies");
    if (syn.anchor) parts.push("anchors the tower onto the target");
    return parts.join(", ");
  }
  // What a tower contributes to synergies: the status it APPLIES sets combos up
  // (finished by other elements); its ELEMENT triggers combos on statuses.
  function synergiesForTower(def) {
    const setsUp = [], triggers = [];
    if (def.status) for (const key in DB.SYNERGIES) {
      const [st, el] = key.split("|");
      if (st === def.status && el !== def.element) setsUp.push({ syn: DB.SYNERGIES[key], status: DB.STATUSES[st], el: DB.ELEMENTS[el] });
    }
    for (const key in DB.SYNERGIES) {
      const [st, el] = key.split("|");
      if (el === def.element && st !== def.status) triggers.push({ syn: DB.SYNERGIES[key], status: DB.STATUSES[st], el: DB.ELEMENTS[el] });
    }
    return { setsUp, triggers };
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
    const v = getView();
    let html;
    if (v.versus) {
      // one row per SEAT: name, element, lives, enemies currently in the corridor
      html = `<div class="ov-head">Corridors · sends travel →</div>`;
      v.state.players.forEach((p, i) => {
        const el = DB.ELEMENTS[p.elements[0]];
        let inside = 0; for (const e of v.state.enemies) if (e.owner === i) inside++;
        const name = i === v.me ? "You" : "NPC " + i;
        html += `<div class="ov-row ${p.alive ? "" : "dead"}" data-ci="${i}">
          <span class="ov-el" style="color:${el.color}">${el.icon} ${name}</span>
          <span class="ov-num">${p.alive ? "❤" + p.lives + " · 👾" + inside : "☠ out"}</span>
          <div class="ov-bar"><div style="width:${Math.min(100, (p.lives / p.maxLives) * 100)}%;background:${p.alive ? el.color : "#555"}"></div></div></div>`;
      });
    } else {
      const fld = v.field;
      html = `<div class="ov-head">Survivors by Origin</div>`;
      for (let i = 0; i < fld.corridorCount; i++) {
        const el = DB.ELEMENTS[fld.elements[i]];
        let alive = 0; for (const e of v.state.enemies) if (e.owner === v.fieldId && e.originIndex === i) alive++;
        const total = fld.corridors[i].spawnedTotal, pct = total ? alive / total : 0;
        html += `<div class="ov-row" data-ci="${i}"><span class="ov-el" style="color:${el.color}">${el.icon} ${el.name}</span><span class="ov-num">${alive}/${total}</span><div class="ov-bar"><div style="width:${pct * 100}%;background:${el.color}"></div></div></div>`;
      }
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
    updateWavePreview();
  }

  // ---- next-wave preview (display-only; mirrors deterministic generateWave) --
  function updateWavePreview() {
    const wp = $("wave-preview"); if (!wp) return;
    const v = getView(), pl = v.field;
    let html = "";
    if (pl.phase === "build" && (v.state.mode === "endless" || pl.wave < pl.totalWaves)) {
      const next = pl.wave + 1;
      const isBoss = next % DB.CONFIG.bossEvery === 0;
      const agg = {};
      for (const g of generateWave(next, pl.corridorCount, DB.CONFIG.bossEvery)) agg[g.type] = (agg[g.type] || 0) + g.count;
      const affix = waveAffix(v.state.seedBase, next, DB.CONFIG.bossEvery);
      const parts = Object.keys(agg).map((t) => {
        const d = DB.ENEMIES[t] || { name: t };
        const n = (affix && affix.countMult) ? Math.max(1, Math.round(agg[t] * affix.countMult)) : agg[t];
        return `<span class="wprev-item${d.boss ? " boss" : ""}">${n}× ${d.name}</span>`;
      });
      html = `<span class="wprev-label${isBoss ? " boss" : ""}">${isBoss ? "⚠ Boss Wave " + next + ":" : "Next:"}</span> ${parts.join('<span class="wprev-sep">·</span>')}`;
      if (affix) html += ` <span class="wprev-affix" title="${affix.desc}">${affix.icon} ${affix.name}</span>`;
    } else if (pl.phase === "prep") {
      html = `<span class="wprev-label boss">⚠ Final:</span> <span class="wprev-item boss">1× ${(DB.ENEMIES.endboss && DB.ENEMIES.endboss.name) || "End Boss"}</span>`;
    }
    wp.innerHTML = html;
    wp.classList.toggle("show", !!html);
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
      const dps = (t.archetype === "support") ? 0 : Math.round(t.damage * t.fireRate);
      const combos = synergiesForTower(t).setsUp;
      b.innerHTML = `<div class="bc-name">${t.name}</div><div class="bc-arch">${t.archetype}</div>`
        + `<div class="bc-stats">⚔ ${t.damage} · ◎ ${t.range.toFixed(1)} · ⚡ ${t.fireRate}${dps ? ` · <b>${dps} DPS</b>` : ""}</div>`
        + (t.status ? `<div class="bc-eff">${DB.STATUSES[t.status].icon} ${DB.STATUSES[t.status].name}</div>` : "")
        + (combos.length ? `<div class="bc-syn">⚗ Combos: ${combos.map((s) => s.el.icon).join(" ")}</div>` : "")
        + `<div class="bc-cost">${t.cost}</div>`;
      // browsing a card previews its range at the build spot (see render/draw.js)
      const preview = () => { v.buildPreview = { range: t.range }; };
      b.addEventListener("pointerenter", preview);
      b.addEventListener("pointerdown", preview);
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
    const refund = sellRefund(def, tw.level);
    let html = `<button class="panel-close" id="tp-close">✕</button>
      <div class="tp-head" style="--ec:${el.color}"><span class="tp-icon">${el.icon}</span><div><div class="tp-name">${def.name}</div><div class="tp-sub">${el.name} · ${def.archetype}</div></div></div>
      <div class="tp-levels"><span class="badge">Lv ${tw.level}/10</span><span class="badge gold">Expert ${tw.expert}/5</span></div>
      <div class="exp-bar"><div style="width:${expPct * 100}%"></div></div>
      <div class="exp-label">${tw.expert < 5 ? tw.kills + " / " + expNeed + " kills" : "MAX EXPERTISE"} · ${tw.kills} total kills</div>
      <div class="tp-stats">
        ${statRow("Damage", cur.dmg.toFixed(0), nxt && nxt.dmg.toFixed(0))}
        ${statRow("Range", cur.range.toFixed(1), nxt && nxt.range.toFixed(1))}
        ${statRow("Atk Speed", cur.rate.toFixed(2), nxt && nxt.rate.toFixed(2))}
        ${def.archetype !== "support" ? statRow("DPS", Math.round(cur.dmg * cur.rate), nxt && Math.round(nxt.dmg * nxt.rate)) : ""}
        ${def.status ? `<div class="tp-eff">${DB.STATUSES[def.status].icon} Applies ${DB.STATUSES[def.status].name}</div>` : ""}
      </div>
      <div class="tp-target"><span class="tt-lbl">Target</span>${["first", "last", "strong", "weak"].map((m) =>
        `<button class="tm-btn ${(tw.targetMode || "first") === m ? "sel" : ""}" data-tm="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
      ${towerSynergyHtml(def)}
      <div class="tp-actions">
        <button id="tp-upgrade" class="${maxed ? "disabled" : ""}">${maxed ? "MAX LEVEL" : "Upgrade · " + cost}</button>
        <button id="tp-sell" class="sell">Sell · +${refund}</button>
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
    p.querySelectorAll("[data-tm]").forEach((b) => b.onclick = () => cmd.setTarget(corr.index, tw.id, b.dataset.tm));
    _twSig = tw.level + "/" + tw.expert + "/" + tw.kills + "/" + tw.mutations.length + "/" + (tw.targetMode || "first");
  }
  // compact synergy block for the tower panel
  function towerSynergyHtml(def) {
    const { setsUp, triggers } = synergiesForTower(def);
    if (!setsUp.length && !triggers.length) return "";
    let h = `<div class="tp-syn"><div class="tp-syn-head">⚗ Synergies</div>`;
    for (const s of setsUp) h += `<div class="tp-syn-row">${s.status.icon}+${s.el.icon} <b style="color:${s.syn.color}">${s.syn.name}</b> — hit ${s.status.name} enemies with ${s.el.name}: ${synergyEffectText(s.syn)}</div>`;
    for (const s of triggers) h += `<div class="tp-syn-row">${s.status.icon}+${s.el.icon} <b style="color:${s.syn.color}">${s.syn.name}</b> — this tower triggers it on ${s.status.name} enemies: ${synergyEffectText(s.syn)}</div>`;
    return h + `</div>`;
  }
  function statRow(label, val, next) { return `<div class="stat-row"><span>${label}</span><span>${val}${(next != null && String(next) !== String(val)) ? ` <em>\u2192 ${next}</em>` : ""}</span></div>`; }
  // display-only sell value (mirrors core totalInvested * sellRefund)
  function sellRefund(def, level) {
    const S = DB.SCALING;
    let invested = def.cost;
    for (let l = 1; l < level; l++) invested += Math.round(def.cost * S.upgradeCostBase * Math.pow(S.costGrowth, l - 1));
    return Math.round(invested * DB.CONFIG.sellRefund);
  }
  // display-only stat projection (mirrors core scaling: per-level + expert bonus)
  function towerView(def, level, expert) {
    const S = DB.SCALING, C = DB.CONFIG;
    const dmg = def.damage * Math.pow(1 + S.damagePerLevel, level - 1) * (1 + (C.expertDamageBonus[expert] || 0));
    const rate = def.fireRate * Math.pow(1 + S.fireRatePerLevel, level - 1);
    const range = def.range + S.rangePerLevel * (level - 1);
    return { dmg, rate, range };
  }

  // ---- enemy panel ---------------------------------------------------------
  const ADAPT_INFO = {
    speed:    { icon: "💨", name: "Swift" },
    health:   { icon: "🩸", name: "Vital" },
    armor:    { icon: "🛡️", name: "Armored" },
    resist:   { icon: "🔰", name: "Resistant" },
    momentum: { icon: "🌀", name: "Momentum" },
    hardened: { icon: "🪨", name: "Hardened" },
  };
  function openEnemyPanel(e) {
    closeAllPanels();
    const v = getView(); v.selectedEnemyId = e.id;
    const oel = DB.ELEMENTS[v.player.elements[e.originIndex]];
    const stk = (e.statusKeys || []).map((k) => DB.STATUSES[k]).filter(Boolean);
    const affix = e.affix && AFFIXES[e.affix];
    // adaptations gained from completed loops (recorded by the sim)
    const adapts = Object.keys(e.adapt || {}).map((k) => {
      const a = ADAPT_INFO[k] || { icon: "↻", name: k }; const n = e.adapt[k];
      return `<span class="stag" style="--sc:#ffd23d">${a.icon} ${a.name}${n > 1 ? " ×" + n : ""}</span>`;
    });
    const p = $("enemy-panel");
    p.innerHTML = `<button class="panel-close" id="ep-close">✕</button>
      <div class="ep-head">${e.boss ? "☠ " : ""}${e.def.id}${e.end ? " (END BOSS)" : ""}${e.sent ? " · SENT" : ""}${affix ? ` · ${affix.icon} ${affix.name.toUpperCase()}` : ""}</div>
      <div class="exp-bar big"><div style="width:${Math.min(1, Math.max(0, e.hp) / e.maxHp) * 100}%;background:#ff4d6d"></div></div>
      <div class="exp-label">${Math.max(0, toI(e.hp))} / ${toI(e.maxHp)} HP</div>
      <div class="tp-stats">${statRow("Origin", oel.icon + " " + oel.name)}${statRow("Loops", e.loopCount)}${statRow("Armor", toI(e.armor))}${statRow("Reward", e.reward)}</div>
      <div class="ep-status">${stk.length ? stk.map((s) => `<span class="stag" style="--sc:${s.color}">${s.icon} ${s.name}</span>`).join("") : "<span class='dim'>No status</span>"}</div>
      ${adapts.length ? `<div class="ep-adapt-head">↻ Loop adaptations</div><div class="ep-status">${adapts.join("")}</div>` : ""}`;
    p.classList.add("show");
    $("ep-close").onclick = closeAllPanels;
  }

  // ---- send panel (competitive + versus): flat costs, 5 upgrade levels ------
  function toggleSendPanel() {
    const p = $("send-panel"); if (!p) return;
    if (p.classList.contains("show")) { closeAllPanels(); return; }
    closeAllPanels();
    p.classList.add("show");
    renderSendPanel(true);
  }
  function sendPanelSig(pl) {
    let sig = "";
    for (const t in DB.SENDS) {
      const lvl = (pl.sendLevels && pl.sendLevels[t]) || 1;
      sig += t + lvl + (pl.gold >= DB.sendCost(t, lvl) ? "y" : "n") + (lvl < DB.SEND_MAX_LEVEL && pl.gold >= DB.sendUpgradeCost(t, lvl) ? "Y" : "N");
    }
    return sig + "|" + Math.floor((getView().player.income || 0));
  }
  function renderSendPanel(force) {
    const p = $("send-panel"); if (!p || !p.classList.contains("show")) return;
    const v = getView(), pl = v.player;
    const sig = sendPanelSig(pl);
    if (!force && sig === _sendSig) return;
    _sendSig = sig;
    let html = `<button class="panel-close" id="sp-close">✕</button>
      <div class="panel-head">⚔ Send Mobs <span class="cur">💰 Income +${pl.income || 0}/5s</span></div>
      <p class="sp-note">${v.versus ? "Sends march into the NEXT corridor. Leaked mobs cost a life and travel on." : "Sends spawn on your opponent's field."} Flat cost per level — upgrade a type to make it stronger (and pricier).</p>
      <div class="sp-rows">`;
    for (const t in DB.SENDS) {
      const s = DB.SENDS[t], en = DB.ENEMIES[t] || { name: t };
      const lvl = (pl.sendLevels && pl.sendLevels[t]) || 1;
      const cost = DB.sendCost(t, lvl);
      const hp = Math.round(en.hp * DB.sendHpMult(t, lvl));
      const maxed = lvl >= DB.SEND_MAX_LEVEL;
      const upCost = maxed ? 0 : DB.sendUpgradeCost(t, lvl);
      html += `<div class="sp-row">
        <div class="sp-info">
          <div class="sp-name">${en.name}${s.count > 1 ? ` <span class="sp-count">×${s.count}</span>` : ""}
            <span class="sp-pips">${[1, 2, 3, 4, 5].map((i) => `<b class="${i <= lvl ? "on" : ""}"></b>`).join("")}</span></div>
          <div class="sp-desc">${s.desc} · ♥ ${hp}${en.armor ? " · 🛡 " + en.armor : ""}${en.speed >= 1.5 ? " · 💨" : ""}</div>
        </div>
        <button class="sp-send ${pl.gold < cost ? "cant" : ""}" data-send="${t}">Send · ${cost}</button>
        <button class="sp-up ${maxed ? "maxed" : (pl.gold < upCost ? "cant" : "")}" data-up="${t}">${maxed ? "MAX" : "⬆ Lv" + (lvl + 1) + " · " + upCost}</button>
      </div>`;
    }
    html += `</div>`;
    p.innerHTML = html;
    $("sp-close").onclick = closeAllPanels;
    p.querySelectorAll("[data-send]").forEach((b) => b.onclick = () => cmd.sendAuto(b.dataset.send));
    p.querySelectorAll("[data-up]").forEach((b) => b.onclick = () => cmd.upgradeSend(b.dataset.up));
  }

  // ---- live panel refresh (tower stats / enemy hp+status update in place) ----
  function refreshPanels() {
    const v = getView(); if (!v.state) return;
    refreshRing(); // live affordability on radial items
    if (v.selectedTowerId) {
      let found = null, fcorr = null;
      for (const c of v.field.corridors) { const t = c.towers.find((t) => t.id === v.selectedTowerId); if (t) { found = t; fcorr = c; break; } }
      if (!found) { closeAllPanels(); _twSig = null; return; }
      const tp = $("tower-panel");
      if (!tp || !tp.classList.contains("show")) return; // ring open, details sheet closed
      const sig = found.level + "/" + found.expert + "/" + found.kills + "/" + found.mutations.length + "/" + (found.targetMode || "first");
      if (sig !== _twSig) openTowerPanel(fcorr, found); // rebuild only when it actually changed -> buttons stay clickable
    } else if (v.selectedEnemyId) {
      const e = v.state.enemies.find((e) => e.id === v.selectedEnemyId && e.owner === v.fieldId);
      if (e && e.alive) openEnemyPanel(e); else closeAllPanels();
    }
    renderSendPanel(false);
    updateBossBar();
  }

  // ---- boss HP bar (top of the game stage while a boss is alive) ------------
  function updateBossBar() {
    const bb = $("boss-bar"); if (!bb) return;
    const v = getView();
    if (!v.state || v.screen !== "game") { bb.classList.remove("show"); return; }
    let boss = null;
    for (const e of v.state.enemies) {
      if (!e.alive || e.owner !== v.fieldId || !e.boss) continue;
      if (!boss || (e.end && !boss.end) || (e.end === boss.end && e.maxHp > boss.maxHp)) boss = e;
    }
    if (!boss) { bb.classList.remove("show"); return; }
    const name = (DB.ENEMIES[boss.type] || {}).name || boss.type;
    setText("boss-name", "☠ " + name + (boss.loopCount ? "  ↻" + boss.loopCount : ""));
    const f = $("boss-fill"); if (f) f.style.width = (Math.max(0, Math.min(1, (boss.hp / boss.maxHp))) * 100) + "%";
    bb.classList.toggle("end", !!boss.end);
    bb.classList.add("show");
  }

  // ---- setup screen --------------------------------------------------------
  // One-line explanations shown under each option group (updates with selection).
  const SETUP_DESCS = {
    mode: {
      single: "One corridor, 10 waves. A short, focused run.",
      loop: "Corridors form a ring — enemies that survive a corridor move on to the next and loop back around until destroyed. 10 waves per corridor.",
      endless: "No final wave. Survive and climb as long as you can.",
    },
    gamemode: {
      solo: "Play alone on your own battlefield.",
      versus: "Offline battle royale: you own ONE corridor in a ring of 3–8. NPC rivals hold the rest. Leaked mobs cost a life and march into the next corridor. Send mobs to bury your neighbor. Last one standing wins.",
      coop: "Defend one shared battlefield and life pool together. Requires a multiplayer room.",
      competitive: "Separate battlefields — spend resources to send extra enemies at your rival. Requires a multiplayer room.",
    },
    econ: {
      shared: "One gold pool pays for every tower, across all corridors.",
      elemental: "Each element earns and spends its own essence — kills pay out in the corridor's element.",
    },
    status: {
      standard: "Enemies carry one status effect at a time — a new one replaces the old.",
      advanced: "Status effects from different towers stack and combine; enemies lock their statuses after each full loop.",
    },
    pacing: {
      manual: "Take your time between waves. You can still toggle ⟳ Auto in-game, and calling a wave early while enemies remain pays a gold bonus.",
      auto: "The next wave starts automatically 5 seconds after the last one is cleared. The final End Boss always waits for you.",
    },
  };
  function updateSetupDescs(setup) {
    setText("desc-mode", SETUP_DESCS.mode[setup.mode] || "");
    setText("desc-gamemode", SETUP_DESCS.gamemode[setup.gameMode] || "");
    setText("desc-econ", SETUP_DESCS.econ[setup.economy] || "");
    setText("desc-status", SETUP_DESCS.status[setup.status] || "");
    setText("desc-pacing", SETUP_DESCS.pacing[setup.pacing] || "");
  }
  function renderSetup(setup, availElements) {
    const vs = setup.gameMode === "versus";
    if (vs && setup.corridors < 3) setup.corridors = 4;
    updateSetupDescs(setup);
    document.querySelectorAll("[data-pacing]").forEach((b) => b.classList.toggle("sel", b.dataset.pacing === setup.pacing));
    // versus forces endless waves + shared gold: grey out the irrelevant chips
    document.querySelectorAll("[data-mode]").forEach((b) => { b.classList.toggle("sel", !vs && b.dataset.mode === setup.mode); b.classList.toggle("disabled", vs); });
    const cc = $("corridor-buttons");
    if (cc && !cc.dataset.built) {
      cc.innerHTML = ""; DB.CORRIDOR_OPTIONS.forEach((n) => { const b = document.createElement("button"); b.className = "chip"; b.textContent = n; b.dataset.cn = n; b.onclick = () => { if (setup.mode === "single" && setup.gameMode !== "versus") return; if (setup.gameMode === "versus" && n < 3) return; setup.corridors = n; renderSetup(setup, availElements); }; cc.appendChild(b); }); cc.dataset.built = "1";
    }
    if (cc) cc.querySelectorAll(".chip").forEach((b) => { b.classList.toggle("sel", +b.dataset.cn === setup.corridors); b.classList.toggle("disabled", (setup.mode === "single" && !vs) || (vs && +b.dataset.cn < 3)); });
    const shape = $("shape-name"); if (shape) shape.textContent = vs ? ("You + " + (setup.corridors - 1) + " NPCs") : (DB.SHAPE_NAMES[setup.corridors] || "");
    if (setup.mode === "single" && !vs) setup.corridors = 1;
    document.querySelectorAll("[data-econ]").forEach((b) => { b.classList.toggle("sel", vs ? b.dataset.econ === "shared" : b.dataset.econ === setup.economy); b.classList.toggle("disabled", vs); });
    document.querySelectorAll("[data-status]").forEach((b) => b.classList.toggle("sel", b.dataset.status === setup.status));
    const wrap = $("element-assign");
    if (wrap) {
      wrap.innerHTML = ""; const n = vs ? 1 : (setup.mode === "single" ? 1 : setup.corridors);
      for (let i = 0; i < n; i++) {
        if (!availElements.includes(setup.elements[i])) setup.elements[i] = availElements[i % availElements.length];
        const row = document.createElement("div"); row.className = "assign-row";
        const lbl = document.createElement("div"); lbl.className = "assign-lbl"; lbl.textContent = vs ? "Your Element (NPCs get the rest at random)" : "Corridor " + (i + 1); row.appendChild(lbl);
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
    const n = setup.gameMode === "versus" ? setup.corridors : (setup.mode === "single" ? 1 : setup.corridors);
    const pts = DB.polygonPoints(n);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36;
    x.lineWidth = 4; x.strokeStyle = "rgba(255,255,255,.25)";
    if (n > 1) {
      x.beginPath();
      pts.forEach((p, i) => { const px = cx + p.x * R, py = cy + p.y * R; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.closePath(); x.stroke();
    }
    const vs = setup.gameMode === "versus";
    pts.forEach((p, i) => {
      const px = cx + p.x * R, py = cy + p.y * R;
      if (vs && i > 0) { // NPC seats: element unknown until the match starts
        x.beginPath(); x.arc(px, py, 22, 0, 7); x.fillStyle = "rgba(255,255,255,.15)"; x.fill();
        x.fillStyle = "rgba(255,255,255,.6)"; x.font = "bold 22px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText("?", px, py + 1);
        return;
      }
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
    // ---- Synergy Codex: cross-element combos, discoverable in one place ----
    html += `<h2 class="codex-head">⚗ Synergy Codex</h2>
      <p class="dim codex-note">Hit an enemy carrying a status with a tower of the listed element to trigger the combo.</p>
      <div class="codex-list">`;
    for (const key in DB.SYNERGIES) {
      const [st, el] = key.split("|");
      const s = DB.STATUSES[st], E = DB.ELEMENTS[el], syn = DB.SYNERGIES[key];
      if (!s || !E) continue;
      html += `<div class="codex-row">
        <span class="cx-combo">${s.icon} ${s.name} <span class="dim">+</span> ${E.icon} ${E.name}</span>
        <span class="cx-name" style="color:${syn.color}">${syn.name}</span>
        <span class="cx-eff">${synergyEffectText(syn)}</span></div>`;
    }
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

  return { toast, setText, closeAllPanels, closeRing, updateTopBar, updateEnemyOverview, updateWavePanel, updateWavePreview, updateBossBar, toggleSendPanel, openBuildMenu, openBuildRing, openTowerRing, openTowerPanel, openEnemyPanel, renderSetup, updateSetupDescs, drawShapePreview, openMastery, renderMultiplayerLobby, refreshPanels };
}

export default { createUI };
