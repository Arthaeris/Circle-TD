/* =============================================================================
 * Circle Tower Wars — save.js
 * THE SAVE / EXPORT / IMPORT LAYER. Answers: "How do we preserve progress?"
 * - Builds save objects from game state (run snapshot + permanent meta)
 * - Reads/writes localStorage
 * - Exports saves as downloadable JSON files and via copy/paste text
 * - Imports pasted text or uploaded JSON files, with validation
 * - Resets progress
 * No combat, rendering, or balancing logic lives here.
 * ===========================================================================*/
const SaveSystem = (function () {
  "use strict";

  const KEY_META = "ctw_meta_v1";
  const KEY_RUN = "ctw_run_v1";
  const FORMAT = "circle-tower-wars-save";
  const FORMAT_VERSION = 1;

  // ---- localStorage helpers (guarded for private mode / disabled storage) ---
  function lsAvailable() {
    try { const k = "__ctw_test__"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  }
  const HAS_LS = lsAvailable();
  function lsGet(k) { try { return HAS_LS ? localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (HAS_LS) localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { if (HAS_LS) localStorage.removeItem(k); } catch (e) {} }

  // -------------------------------------------------------------------------
  // DEFAULT META (permanent progression)
  // -------------------------------------------------------------------------
  function defaultMeta() {
    return {
      version: FORMAT_VERSION,
      totalWins: 0,
      mastery: { fire: 0, ice: 0, nature: 0, storm: 0, light: 0, darkness: 0, mech: 0, abnormal: 0 },
      elementWins: { fire: 0, ice: 0, nature: 0, storm: 0, light: 0, darkness: 0, mech: 0, abnormal: 0 },
      maxWaveByElement: { fire: 0, ice: 0, nature: 0, storm: 0, light: 0, darkness: 0, mech: 0, abnormal: 0 },
      highScore: 0,
    };
  }

  function loadMeta() {
    const raw = lsGet(KEY_META);
    if (!raw) return defaultMeta();
    try {
      const m = JSON.parse(raw);
      return migrateMeta(m);
    } catch (e) { return defaultMeta(); }
  }
  function migrateMeta(m) {
    const d = defaultMeta();
    if (!m || typeof m !== "object") return d;
    d.totalWins = m.totalWins || 0;
    d.highScore = m.highScore || 0;
    for (const e in d.mastery) {
      d.mastery[e] = (m.mastery && m.mastery[e]) || 0;
      d.elementWins[e] = (m.elementWins && m.elementWins[e]) || 0;
      d.maxWaveByElement[e] = (m.maxWaveByElement && m.maxWaveByElement[e]) || 0;
    }
    return d;
  }
  function saveMeta(meta) { lsSet(KEY_META, JSON.stringify(meta)); }

  // -------------------------------------------------------------------------
  // RUN SNAPSHOT (in-progress game)
  // -------------------------------------------------------------------------
  function hasRun() { return !!lsGet(KEY_RUN); }
  function saveRun(runData) { lsSet(KEY_RUN, JSON.stringify(sanitizeRun(runData))); }
  function loadRun() {
    const raw = lsGet(KEY_RUN);
    if (!raw) return null;
    try { return validateRun(JSON.parse(raw)); } catch (e) { return null; }
  }
  function clearRun() { lsDel(KEY_RUN); }

  function sanitizeRun(d) {
    // Infinity is not valid JSON -> store as null
    const clone = JSON.parse(JSON.stringify(d, (k, v) => v === Infinity ? null : v));
    return clone;
  }

  function validateRun(d) {
    if (!d || typeof d !== "object") throw new Error("not an object");
    if (!Array.isArray(d.corridors)) throw new Error("no corridors");
    if (!Array.isArray(d.elements)) throw new Error("no elements");
    if (typeof d.lives !== "number") throw new Error("no lives");
    return d;
  }

  // -------------------------------------------------------------------------
  // EXPORT — wraps payload with format header
  // -------------------------------------------------------------------------
  function wrap(kind, payload) {
    return JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, kind, exportedAt: new Date().toISOString(), payload }, (k, v) => v === Infinity ? null : v, 2);
  }
  function exportRunText(runData) { return wrap("run", sanitizeRun(runData)); }
  function exportMetaText(meta) { return wrap("meta", meta); }

  function exportRun(runData) { downloadText(exportRunText(runData), "circle-tower-wars-run.json"); }
  function exportMeta(meta) { downloadText(exportMetaText(meta), "circle-tower-wars-progress.json"); }

  function downloadText(text, filename) {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename || "save.json";
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (e) { /* download unsupported */ }
  }

  // -------------------------------------------------------------------------
  // IMPORT — accepts wrapped exports or raw payloads
  // -------------------------------------------------------------------------
  function importText(text) {
    if (!text || !text.trim()) return { ok: false, error: "empty input" };
    let obj;
    try { obj = JSON.parse(text.trim()); } catch (e) { return { ok: false, error: "invalid JSON" }; }

    // wrapped export
    if (obj && obj.format === FORMAT && obj.payload) {
      if (obj.kind === "run") {
        try { return { ok: true, kind: "run", data: validateRun(obj.payload) }; }
        catch (e) { return { ok: false, error: "bad run data (" + e.message + ")" }; }
      }
      if (obj.kind === "meta") return { ok: true, kind: "meta", data: migrateMeta(obj.payload) };
      return { ok: false, error: "unknown kind" };
    }
    // raw run?
    if (obj && Array.isArray(obj.corridors)) {
      try { return { ok: true, kind: "run", data: validateRun(obj) }; }
      catch (e) { return { ok: false, error: "bad run data" }; }
    }
    // raw meta?
    if (obj && obj.mastery) return { ok: true, kind: "meta", data: migrateMeta(obj) };
    return { ok: false, error: "unrecognized save format" };
  }

  // -------------------------------------------------------------------------
  // PROGRESSION RECORDING
  // -------------------------------------------------------------------------
  function uniqueElements(state) {
    const set = new Set(state.elements);
    return Array.from(set);
  }

  // recompute a single element's mastery level from stored stats
  function computeLevel(meta, e) {
    const wins = meta.elementWins[e] || 0;
    const wave = meta.maxWaveByElement[e] || 0;
    let lvl = 0;
    if (wins >= 1) lvl = 1;
    if (wins >= 3) lvl = 2;
    if (wins >= 10) lvl = 3;
    if (wins >= 20) lvl = 4;
    if (wave >= 100 && lvl >= 4) lvl = 5; // Wave 100 -> Mastery 5 (Endless counts; no win required beyond L4)
    return lvl;
  }

  // returns array of unlock description strings
  function recomputeAndDiff(meta, before) {
    const msgs = [];
    const D = window.DB;
    // elements available before/after
    const availBefore = before.avail;
    const availAfter = new Set(D.availableElements(meta.mastery));
    for (const e of availAfter) {
      if (!availBefore.has(e)) msgs.push("New Element unlocked: " + D.ELEMENTS[e].name);
    }
    // mastery level increases + tower/mutation unlocks
    for (const e in meta.mastery) {
      const was = before.mastery[e] || 0, now = meta.mastery[e] || 0;
      if (now > was) {
        msgs.push(D.ELEMENTS[e].name + " Mastery " + now);
        for (let lvl = was + 1; lvl <= now; lvl++) {
          (D.MASTERY.unlocks[lvl] || []).forEach(u => msgs.push(D.ELEMENTS[e].name + ": " + u));
        }
      }
    }
    return msgs;
  }

  function snapshot(meta) {
    return {
      mastery: Object.assign({}, meta.mastery),
      avail: new Set(window.DB.availableElements(meta.mastery)),
    };
  }

  function recordVictory(meta, state) {
    const before = snapshot(meta);
    meta.totalWins = (meta.totalWins || 0) + 1;
    const els = uniqueElements(state);
    els.forEach(e => {
      meta.elementWins[e] = (meta.elementWins[e] || 0) + 1;
      const w = state.mode === "endless" ? state.wave : state.totalWaves;
      meta.maxWaveByElement[e] = Math.max(meta.maxWaveByElement[e] || 0, w);
    });
    meta.highScore = Math.max(meta.highScore || 0, state.score || 0);
    // recompute mastery for all elements (two passes: L4 thresholds may enable L5 elsewhere)
    for (const e in meta.mastery) meta.mastery[e] = computeLevel(meta, e);
    const msgs = recomputeAndDiff(meta, before);
    clearRun(); // run finished
    return msgs;
  }

  function recordDefeat(meta, state) {
    const els = uniqueElements(state);
    els.forEach(e => {
      meta.maxWaveByElement[e] = Math.max(meta.maxWaveByElement[e] || 0, state.wave || 0);
    });
    meta.highScore = Math.max(meta.highScore || 0, state.score || 0);
    for (const e in meta.mastery) meta.mastery[e] = computeLevel(meta, e);
    clearRun();
  }

  function resetAll() { lsDel(KEY_META); lsDel(KEY_RUN); }

  // -------------------------------------------------------------------------
  // EXPORT API
  // -------------------------------------------------------------------------
  return {
    loadMeta, saveMeta,
    hasRun, saveRun, loadRun, clearRun,
    exportRun, exportMeta, exportRunText, exportMetaText, downloadText,
    importText,
    recordVictory, recordDefeat,
    resetAll,
    HAS_LS,
  };
})();