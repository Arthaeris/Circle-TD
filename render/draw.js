/* =============================================================================
 * Circle Tower Wars — render/draw.js
 * CANVAS RENDERER (shell). Reads the deterministic sim state and DRAWS it; it
 * never mutates state (§2 boundary). Fixed-point positions are converted to
 * float pixels only here, at the very edge. Supports render interpolation
 * (`alpha`) so motion stays smooth at any local render fps (§4).
 *
 * It draws the field of ONE player (the local player by default; the spectator
 * can view a peer's field in multiplayer). All asset paths keep .PNG (D1) and
 * fall back to vector drawing if an image is missing — same as the original.
 * ===========================================================================*/
import * as fx from "../sim/fx.js";

const TILE = (v) => fx.toFloat(v); // fixed tiles -> float tiles

export function createRenderer(opts) {
  const canvas = opts.canvas, assets = opts.assets, DB = opts.DB;
  let ctx = canvas.getContext("2d");
  let dpr = 1;

  function resize() {
    const wrap = canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx = canvas.getContext("2d");
  }
  const cw = () => canvas.width / dpr;
  const ch = () => canvas.height / dpr;

  // ---- geometry helpers ----------------------------------------------------
  function worldGeom() { const W = cw(), H = ch(); return { cx: W / 2, cy: H / 2, R: Math.min(W, H) * 0.34 }; }
  // versus: one gate per SEAT; otherwise one per corridor of the viewed field
  function worldCount(view) { return view.versus ? view.state.players.length : view.field.corridorCount; }
  function worldCorr(view, i) { return view.versus ? view.state.players[i].corridors[0] : view.field.corridors[i]; }
  function gatePositions(view) {
    const g = worldGeom();
    const pts = DB.polygonPoints(worldCount(view));
    return pts.map((p) => ({ x: g.cx + p.x * g.R, y: g.cy + p.y * g.R }));
  }
  function fieldGeom(view) {
    const G = view.state.grid, W = cw();
    const pad = 12, top = view.fieldTopInset ? view.fieldTopInset() : 12;
    const base = (W - pad * 2) / G.cols;
    const ts = base * view.fieldCam.zoom;
    return { ts, ox: pad + view.fieldCam.x, oy: top + view.fieldCam.y };
  }

  // ---- public entry --------------------------------------------------------
  function render(view, alpha) {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw(), ch());
    if (view.screen !== "game") return;
    if (view.view === "world") renderWorld(view);
    else renderField(view, alpha == null ? 1 : alpha);
  }

  // ---- WORLD map -----------------------------------------------------------
  function renderWorld(view) {
    const W = cw(), H = ch();
    if (!assets.draw("assets/world/background.PNG", 0, 0, W, H)) {
      const g = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "#1b2140"); g.addColorStop(1, "#0a0c1c");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    const gates = gatePositions(view);
    const wg = worldGeom();
    if (worldCount(view) > 1) {
      ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 14; ctx.lineCap = "round";
      ctx.beginPath(); gates.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
      for (let i = 0; i < gates.length; i++) drawArrow(gates[i], gates[(i + 1) % gates.length], view);
    }
    drawVortex(wg.cx, wg.cy, view);
    gates.forEach((p, i) => drawGate(p, i, view));
    view._vortex = { cx: wg.cx, cy: wg.cy, r: 46 };
  }

  function drawArrow(a, b, view) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ang = Math.atan2(b.y - a.y, b.x - a.x), size = 40;
    const img = assets.get("assets/world/arrow.PNG");
    ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
    if (img && img.ready) ctx.drawImage(img, -size / 2, -size / 2, size, size);
    else { ctx.fillStyle = "rgba(255,255,255,.4)"; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }

  function drawVortex(cx, cy, view) {
    const fld = view.versus ? view.state.players[view.me] : view.field; // versus: my seat's wave
    const active = fld.phase === "prep", r = 46;
    const path = active ? "assets/world/vortex_active.PNG" : "assets/world/vortex_idle.PNG";
    const img = assets.get(path);
    if (img && (img.ready || (img.complete && img.naturalWidth > 0))) {
      img.ready = true; const spin = view.time * (active ? 2.8 : 0.8);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(spin); ctx.drawImage(img, -r, -r, r * 2, r * 2); ctx.restore();
    } else {
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
      if (active) { grad.addColorStop(0, "#ff2e7e"); grad.addColorStop(1, "#3a0d2a"); }
      else { grad.addColorStop(0, "#3a4170"); grad.addColorStop(1, "#10132a"); }
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    }
    const overlay = active ? "assets/world/vortex_text_summon.PNG" : "assets/world/vortex_text_wave.PNG";
    if (!assets.draw(overlay, cx - r, cy - r, r * 2, r * 2)) {
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (active) { ctx.font = "bold 16px system-ui"; ctx.fillText("SUMMON", cx, cy - 4); ctx.font = "11px system-ui"; ctx.fillText("End Boss", cx, cy + 12); }
      else {
        ctx.font = "bold 18px system-ui"; ctx.fillText("Wave", cx, cy - 8);
        ctx.font = "bold 20px system-ui";
        ctx.fillText(view.state.mode === "endless" ? fld.wave : (fld.wave + "/" + fld.totalWaves), cx, cy + 12);
      }
    }
  }

  function drawGate(p, i, view) {
    const corr = worldCorr(view, i), el = DB.ELEMENTS[corr.element], r = 34;
    const seat = view.versus ? view.state.players[i] : null;
    const inside = countEnemies(view, i, "corr"), origin = countEnemies(view, i, "origin");
    ctx.save();
    if (seat && !seat.alive) ctx.globalAlpha = 0.35; // eliminated seat
    if (inside > 0) { ctx.shadowColor = el.color; ctx.shadowBlur = 18; }
    const gateAsset = el.gateAsset || `assets/world/gates/${corr.element}.PNG`;
    const img = assets.get(gateAsset);
    if (img && img !== false && (img.ready || (img.complete && img.naturalWidth > 0))) {
      img.ready = true; const gw = r * 3.2, gh = gw * (img.naturalHeight / img.naturalWidth);
      ctx.drawImage(img, p.x - gw * 0.5, p.y - gh * 0.42, gw, gh);
    } else {
      const grad = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, r);
      grad.addColorStop(0, el.glow); grad.addColorStop(1, el.dark);
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      ctx.fillStyle = "#0d0f1a"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "26px serif"; ctx.fillText(el.icon, p.x, p.y - 2);
      ctx.lineWidth = (i === view.activeCorridor) ? 5 : 3; ctx.strokeStyle = (i === view.activeCorridor) ? "#fff" : el.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    if (seat) {
      // versus: seat name + lives + enemies inside
      ctx.font = "bold 13px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = i === view.me ? "#ffd23d" : "#fff";
      ctx.fillText(seat.alive ? (i === view.me ? "YOU" : "NPC " + i) : "☠", p.x, p.y + r + 14);
      ctx.font = "12px system-ui"; ctx.fillStyle = "#cfe";
      ctx.fillText(seat.alive ? ("❤" + seat.lives + "  👾" + inside) : "eliminated", p.x, p.y + r + 30);
    } else {
      ctx.font = "bold 16px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"; ctx.fillText(inside, p.x, p.y + r + 14);
      ctx.font = "12px system-ui"; ctx.fillStyle = "#cfe"; ctx.fillText(origin + "/" + corr.spawnedTotal, p.x, p.y + r + 30);
    }
    ctx.restore();
  }

  function countEnemies(view, ci, kind) {
    let n = 0;
    for (const e of view.state.enemies) {
      if (view.versus) { if (e.owner === ci) n++; continue; } // versus: seat = owner
      if (e.owner !== view.fieldId) continue;
      if (kind === "corr" && e.corridorIndex === ci) n++;
      else if (kind === "origin" && e.originIndex === ci) n++;
    }
    return n;
  }

  // ---- FIELD ---------------------------------------------------------------
  function renderField(view, alpha) {
    // versus: view.field is the viewed SEAT (one corridor); otherwise index in my field
    const corr = view.versus ? view.field.corridors[0] : view.field.corridors[view.activeCorridor];
    if (!corr) return;
    const G = view.state.grid, el = DB.ELEMENTS[corr.element];
    const { ts, ox, oy } = fieldGeom(view);
    const W = cw(), H = ch();
    if (!assets.draw("assets/ui/field-background.PNG", 0, 0, W, H)) { ctx.fillStyle = "#0a0c1c"; ctx.fillRect(0, 0, W, H); }
    const cbg = el.fieldAsset || `assets/corridors/${corr.element}.PNG`;
    if (!assets.draw(cbg, ox, oy, ts * G.cols, ts * G.rows)) {
      const g = ctx.createLinearGradient(0, oy, 0, oy + ts * G.rows); g.addColorStop(0, el.dark); g.addColorStop(1, "#0e1020");
      ctx.fillStyle = g; ctx.fillRect(ox, oy, ts * G.cols, ts * G.rows);
    }
    if (!assets.draw("assets/ui/grid-overlay.PNG", ox, oy, ts * G.cols, ts * G.rows)) {
      ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let c = 0; c <= G.cols; c++) { ctx.moveTo(ox + c * ts, oy); ctx.lineTo(ox + c * ts, oy + ts * G.rows); }
      for (let r = 0; r <= G.rows; r++) { ctx.moveTo(ox, oy + r * ts); ctx.lineTo(ox + ts * G.cols, oy + r * ts); }
      ctx.stroke();
    }
    // obstacles (grid cell code 1)
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) if (corr.grid[r * G.cols + c] === 1) drawObstacle(ox + c * ts, oy + r * ts, ts, el, (r + c) % 2);
    drawPortal(corr.entrance, ts, ox, oy, el, true);
    drawPortal(corr.exit, ts, ox, oy, el, false);
    // build preview — at the ACTUAL spot the sim would build (view.buildSpot), or hidden
    if (view.buildMenuOpen && view.buildSpot) {
      const sp = view.buildSpot;
      const bx = ox + sp.c * ts, by = oy + sp.r * ts, bs = ts * 3;
      if (!assets.draw("assets/ui/build-preview.PNG", bx, by, bs, bs)) { ctx.fillStyle = "rgba(80,255,120,.25)"; ctx.fillRect(bx, by, bs, bs); }
      // range ring for the tower card currently being browsed in the build menu
      if (view.buildPreview && view.buildPreview.range) {
        const rr = view.buildPreview.range * ts;
        const rx = bx + bs / 2, ry = by + bs / 2;
        ctx.beginPath(); ctx.arc(rx, ry, rr, 0, 7);
        ctx.strokeStyle = "rgba(120,255,160,.6)"; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "rgba(120,255,160,.07)"; ctx.fill();
      }
    }
    for (const tw of corr.towers) drawTower(tw, ts, ox, oy, el, view);
    // range circle for selected tower
    if (view.selectedTowerId) {
      const tw = corr.towers.find((t) => t.id === view.selectedTowerId);
      if (tw) { const rr = TILE(towerRange(tw)) * ts; const rx = ox + TILE(tw.cx) * ts, ry = oy + TILE(tw.cy) * ts;
        if (!assets.draw("assets/ui/range-circle.PNG", rx - rr, ry - rr, rr * 2, rr * 2)) {
          ctx.beginPath(); ctx.arc(rx, ry, rr, 0, 7); ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,.06)"; ctx.fill();
        } } }
    // enemies (interpolated)
    for (const e of view.state.enemies) {
      if (e.owner !== view.fieldId || e.corridorIndex !== corr.index) continue;
      drawEnemy(e, ts, ox, oy, view, alpha);
    }
    // projectiles
    for (const p of view.state.projectiles) {
      if (p.owner !== view.fieldId || p.corr.index !== corr.index) continue;
      const px = ox + TILE(p.x) * ts, py = oy + TILE(p.y) * ts, pr = Math.max(3, ts * 0.12);
      const asset = `assets/projectiles/${p.element}.PNG`;
      if (!assets.draw(asset, px - pr, py - pr, pr * 2, pr * 2)) { ctx.fillStyle = DB.ELEMENTS[p.element].color; ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.fill(); }
    }
  }

  function towerRange(tw) {
    // mirror core's range scaling for the ring (display only)
    const S = DB.SCALING; let range = DB.TOWER_BY_ID[tw.def.id].range;
    range = fx.fromFloat(range) + fx.mul(fx.fromFloat(S.rangePerLevel), fx.fromInt(tw.level - 1));
    return range;
  }

  function drawObstacle(x, y, ts, el, variant) {
    const id = el.id; const asset = `assets/obstacles/${id}_${variant}.PNG`;
    const dw = ts * 1.3, dh = ts * 1.7, dx = x + (ts - dw) / 2, dy = y + (ts - dh) / 2;
    if (assets.draw(asset, dx, dy, dw, dh)) return;
    ctx.fillStyle = el.dark; ctx.strokeStyle = el.color; ctx.lineWidth = 2; ctx.beginPath();
    const cx = x + ts / 2, cy = y + ts / 2, r = ts * 0.42;
    for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28, px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  function drawPortal(pt, ts, ox, oy, el, entrance) {
    const baseX = ox + (pt.c - 1) * ts, baseY = oy + pt.r * ts, baseW = ts * 3, baseH = ts;
    const w = ts * 7, h = ts * 2, cX = baseX + baseW / 2, cY = baseY + baseH / 2;
    const asset = entrance ? "assets/portals/in.PNG" : "assets/portals/out.PNG";
    if (assets.draw(asset, cX - w / 2, cY - h / 2, w, h)) return;
    const grad = ctx.createLinearGradient(baseX, baseY, baseX, baseY + baseH);
    grad.addColorStop(0, entrance ? "#2bd66e" : el.color); grad.addColorStop(1, "#000");
    ctx.fillStyle = grad; ctx.fillRect(baseX, baseY, baseW, baseH);
    ctx.fillStyle = "#fff"; ctx.font = "bold " + (ts * 0.5) + "px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(entrance ? "IN" : "OUT", baseX + baseW / 2, baseY + baseH / 2);
  }

  function drawTower(tw, ts, ox, oy, el, view) {
    const x = ox + tw.c * ts, y = oy + tw.r * ts, s = ts * 3;
    ctx.save(); ctx.shadowColor = el.color; ctx.shadowBlur = 10 + Math.sin(view.time * 2.5) * 3;
    assets.draw("assets/ui/tower-base.PNG", x, y, s, s); ctx.restore();
    const asset = tw.def.asset || `assets/towers/${tw.def.id}.PNG`;
    const aw = s, ah = s * 1.25, axp = x + (s - aw) / 2, ayp = y + s - ah;
    if (!assets.draw(asset, axp, ayp, aw, ah)) {
      ctx.fillStyle = el.dark; ctx.fillRect(x + 2, y + 2, s - 4, s - 4);
      ctx.strokeStyle = el.color; ctx.lineWidth = 3; ctx.strokeRect(x + 2, y + 2, s - 4, s - 4);
      ctx.fillStyle = "#0d0f1a"; ctx.font = (s * 0.3) + "px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(el.icon, x + s / 2, y + s / 2);
    }
    if (tw.id === view.selectedTowerId && !assets.draw("assets/ui/tower-selected-frame.PNG", x, y, s, s)) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.strokeRect(x, y, s, s); }
    ctx.fillStyle = "#fff"; ctx.font = "bold " + (ts * 0.5) + "px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(tw.level, x + s - ts * 0.5, y + ts * 0.5);
    if (tw.expert > 0) { ctx.fillStyle = "#ffe066"; ctx.font = (ts * 0.4) + "px system-ui"; ctx.fillText("★".repeat(Math.min(3, tw.expert)), x + s / 2, y + s - ts * 0.35); }
    if (tw.mutations.length) { ctx.fillStyle = "#ff5fa2"; ctx.beginPath(); ctx.arc(x + ts * 0.4, y + ts * 0.4, ts * 0.16, 0, 7); ctx.fill(); }
  }

  function drawEnemy(e, ts, ox, oy, view, alpha) {
    // interpolate from previous to current position for smooth motion (§4)
    const px = e.px == null ? TILE(e.fx) : e.px + (TILE(e.fx) - e.px) * alpha;
    const py = e.py == null ? TILE(e.fy) : e.py + (TILE(e.fy) - e.py) * alpha;
    const x = ox + px * ts, y = oy + py * ts, r = TILE(e.def.radius) * ts * 2.2;
    const dbE = DB.ENEMIES[e.type] || {};
    const asset = dbE.asset || `assets/enemies/${e.type}.PNG`;
    if (!assets.draw(asset, x - r, y - r, r * 2, r * 2)) {
      ctx.fillStyle = e.statuses && e.statuses["frozen"] ? "#bff0ff" : (dbE.color || "#d96b4a");
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    // boss ring
    if (e.boss && !assets.draw("assets/ui/enemy-boss-ring.PNG", x - r - 4, y - r - 4, (r + 4) * 2, (r + 4) * 2)) {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    }
    // selected ring
    if (e.id === view.selectedEnemyId && !assets.draw("assets/ui/enemy-selected-ring.PNG", x - r - 6, y - r - 6, (r + 6) * 2, (r + 6) * 2)) {
      ctx.strokeStyle = "#ffe066"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + 3, 0, 7); ctx.stroke();
    }
    // origin-element ring (shows which corridor the enemy came from)
    const oid = view.field.elements[e.originIndex];
    const oel = DB.ELEMENTS[oid];
    if (oel && !assets.draw(`assets/ui/origin-rings/${oid}.PNG`, x - r - 3, y - r - 3, (r + 3) * 2, (r + 3) * 2)) {
      ctx.strokeStyle = oel.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.stroke();
    }
    // sent marker (competitive)
    if (e.sent) { ctx.strokeStyle = "#ff5fa2"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 7); ctx.stroke(); }
    // hp bar
    const w = r * 2, h = 4, hpc = Math.max(0, e.hp) / e.maxHp;
    if (!assets.draw("assets/ui/hpbar-frame.PNG", x - w / 2, y - r - 10, w, 6)) { ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(x - w / 2, y - r - 8, w, h); }
    let hpAsset = hpc <= 0.25 ? "assets/ui/hpbar-red.PNG" : hpc <= 0.5 ? "assets/ui/hpbar-yellow.PNG" : "assets/ui/hpbar-green.PNG";
    if (!assets.draw(hpAsset, x - w / 2, y - r - 8, w * hpc, h)) {
      ctx.fillStyle = hpc > 0.5 ? "#5fe07a" : hpc > 0.25 ? "#ffd23d" : "#ff4d6d"; ctx.fillRect(x - w / 2, y - r - 8, w * hpc, h);
    }
    // status icon (first non-adaptive status)
    const sk = (e.statusKeys || []).filter(k => DB.STATUSES[k] && !DB.STATUSES[k].adaptive);
    if (sk.length) {
      const st = DB.STATUSES[sk[0]];
      if (!assets.draw(st.asset || `assets/status/${sk[0]}.PNG`, x + r - 4, y - r - 4, 12, 12)) {
        ctx.fillStyle = st.color; ctx.beginPath(); ctx.arc(x + r, y - r, 4, 0, 7); ctx.fill();
      }
    }
    if (e.loopCount > 0) { ctx.fillStyle = "#ffd23d"; ctx.font = "bold " + (ts * 0.4) + "px system-ui"; ctx.textAlign = "center"; ctx.fillText("↻" + e.loopCount, x, y + r + 12); }
  }

  // Snapshot enemy positions each tick so the next frame can interpolate (§4).
  function snapshotPositions(state) {
    for (const e of state.enemies) { e.px = TILE(e.fx); e.py = TILE(e.fy); }
  }

  return { render, resize, snapshotPositions, worldGeom, gatePositions, fieldGeom, cw, ch, get dpr() { return dpr; } };
}

export default { createRenderer };
