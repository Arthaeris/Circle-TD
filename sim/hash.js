/* =============================================================================
 * Circle Tower Wars — sim/hash.js
 * STATE HASHING + CONTENT HASHING (§6.4).
 *
 * Two jobs:
 *   1) hashState(state): a compact 32-bit fingerprint of the deterministic
 *      sim state, computed every ~30 ticks by every client and compared. A
 *      mismatch means a desync — logged, and the host's state is treated as
 *      truth (resync or clean match end).
 *   2) hashContent(DB): a fingerprint of all balancing data. Both clients must
 *      share the same game version AND the same content hash before a match
 *      starts (content-gating, §6.4). DB.version is extended to carry it.
 *
 * FNV-1a (32-bit) — order-sensitive, fast, no floats, identical everywhere.
 * ===========================================================================*/

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function newHash() { return FNV_OFFSET >>> 0; }

export function mixU32(h, v) {
  v = v >>> 0;
  h ^= v & 0xff;          h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 8) & 0xff;  h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 16) & 0xff; h = Math.imul(h, FNV_PRIME);
  h ^= (v >>> 24) & 0xff; h = Math.imul(h, FNV_PRIME);
  return h >>> 0;
}

export function mixInt(h, n) { return mixU32(h, n | 0); }

export function mixStr(h, s) {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Hash the deterministic part of a sim state. Iterates players/corridors/
 * enemies/towers/projectiles in stable array order (§3 rule 4 — never Set/Map
 * iteration order). Everything fed in is integer (fixed-point or counts), so
 * the result is bit-stable across engines.
 */
export function hashState(state) {
  let h = newHash();
  h = mixInt(h, state.tick);
  h = mixInt(h, state.seedSim.s);
  h = mixInt(h, state.netSpeed || 1);
  for (const pl of state.players) {
    h = mixInt(h, pl.lives);
    h = mixInt(h, pl.gold);
    h = mixInt(h, pl.income);
    h = mixInt(h, pl.wave);
    h = mixInt(h, pl.alive ? 1 : 0);
    // per-element essence in fixed element order
    for (const e of state.elementOrder) h = mixInt(h, pl.essence[e] | 0);
    for (const corr of pl.corridors) {
      h = mixInt(h, corr.spawnedTotal);
      for (const t of corr.towers) {
        h = mixInt(h, t.cx); h = mixInt(h, t.cy); h = mixInt(h, t.owner | 0);
        h = mixInt(h, t.level); h = mixInt(h, t.expert); h = mixInt(h, t.kills);
        h = mixInt(h, t.cd);
      }
    }
  }
  // enemies are a global stable array
  for (const e of state.enemies) {
    h = mixInt(h, e.id);
    h = mixInt(h, e.fx); h = mixInt(h, e.fy);
    h = mixInt(h, e.hp); h = mixInt(h, e.owner);
    h = mixInt(h, e.corridorIndex); h = mixInt(h, e.loopCount);
  }
  for (const p of state.projectiles) {
    h = mixInt(h, p.x); h = mixInt(h, p.y);
  }
  return h >>> 0;
}

/** Stable JSON-ish walk of the balancing DB for content-gating. */
export function hashContent(DB) {
  let h = newHash();
  h = mixInt(h, DB.codeVersion || 0);
  const walk = (v) => {
    if (v == null) { h = mixStr(h, "null"); return; }
    const t = typeof v;
    if (t === "number") { h = mixInt(h, Math.round(v * 1000)); return; }
    if (t === "boolean") { h = mixInt(h, v ? 1 : 0); return; }
    if (t === "string") { h = mixStr(h, v); return; }
    if (Array.isArray(v)) { h = mixStr(h, "["); v.forEach(walk); h = mixStr(h, "]"); return; }
    if (t === "object") {
      const keys = Object.keys(v).sort();
      for (const k of keys) { h = mixStr(h, k); walk(v[k]); }
      return;
    }
    // functions etc. are ignored (logic, not content)
  };
  walk({
    CONFIG: DB.CONFIG, ELEMENTS: DB.ELEMENTS, STATUSES: DB.STATUSES,
    SYNERGIES: DB.SYNERGIES, TOWERS: DB.TOWERS, ENEMIES: DB.ENEMIES,
    SCALING: DB.SCALING, MASTERY: DB.MASTERY, COMPETITIVE: DB.COMPETITIVE,
  });
  return (h >>> 0).toString(16).padStart(8, "0");
}

export default { newHash, mixU32, mixInt, mixStr, hashState, hashContent };
