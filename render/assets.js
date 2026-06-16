/* =============================================================================
 * Circle Tower Wars — render/assets.js
 * Image cache + preloader (shell-only; never touched by the sim-core). Same
 * behaviour as the original Assets helper: lazy <img> load, draw-with-fallback,
 * and a Promise-based preloader for the loading screen. All asset paths keep
 * the UPPERCASE .PNG extension (Decision D1).
 * ===========================================================================*/
export function createAssets(getCtx) {
  const cache = Object.create(null);

  function get(path) {
    if (!path) return null;
    if (cache[path] === false) return null;
    if (cache[path]) return cache[path];
    const img = new Image();
    img.ready = false;
    img.onload = () => { img.ready = true; };
    img.onerror = () => { console.warn("Asset failed to load:", path); cache[path] = false; };
    img.src = path;
    cache[path] = img;
    return img;
  }

  function draw(path, x, y, w, h) {
    const img = get(path);
    if (!img) return false;
    if (img.ready || (img.complete && img.naturalWidth > 0)) {
      img.ready = true;
      getCtx().drawImage(img, x, y, w, h);
      return true;
    }
    return false;
  }

  function preload(paths, onProgress) {
    const unique = [...new Set(paths.filter(Boolean))];
    let done = 0;
    return Promise.allSettled(unique.map((path) => new Promise((resolve) => {
      const img = get(path);
      if (!img) { done++; onProgress && onProgress(done, unique.length); return resolve({ path, ok: false }); }
      if (img.ready || (img.complete && img.naturalWidth > 0)) { img.ready = true; done++; onProgress && onProgress(done, unique.length); return resolve({ path, ok: true }); }
      const oldLoad = img.onload, oldErr = img.onerror;
      img.onload = () => { img.ready = true; oldLoad && oldLoad.call(img); done++; onProgress && onProgress(done, unique.length); resolve({ path, ok: true }); };
      img.onerror = () => { cache[path] = false; oldErr && oldErr.call(img); done++; onProgress && onProgress(done, unique.length); resolve({ path, ok: false }); };
    })));
  }

  return { get, draw, preload, cache };
}

// Build the same asset list the original game preloaded (keeps .PNG casing, D1).
export function collectPreloadAssets(DB) {
  const paths = [
    "assets/world/background.PNG", "assets/world/connection.PNG", "assets/world/arrow.PNG",
    "assets/world/vortex_active.PNG", "assets/world/vortex_idle.PNG",
    "assets/world/vortex_text_summon.PNG", "assets/world/vortex_text_wave.PNG",
    "assets/ui/field-background.PNG", "assets/ui/grid-overlay.PNG", "assets/ui/build-preview.PNG",
    "assets/ui/range-circle.PNG", "assets/ui/tower-base.PNG", "assets/ui/tower-selected-frame.PNG",
    "assets/ui/tower-level-badge.PNG", "assets/ui/mutation-dot.PNG", "assets/ui/enemy-boss-ring.PNG",
    "assets/ui/enemy-selected-ring.PNG", "assets/ui/hpbar-frame.PNG", "assets/ui/hpbar-green.PNG",
    "assets/ui/hpbar-yellow.PNG", "assets/ui/hpbar-red.PNG",
    "assets/portals/in.PNG", "assets/portals/out.PNG",
    "assets/effects/bolt.PNG", "assets/effects/beam.PNG", "assets/effects/burst.PNG", "assets/effects/melee.PNG",
  ];
  for (let i = 1; i <= 5; i++) paths.push(`assets/ui/expert-${i}.PNG`);
  DB.ELEMENT_ORDER.forEach((id) => {
    const el = DB.ELEMENTS[id];
    paths.push(
      el.gateAsset || `assets/world/gates/${id}.PNG`,
      el.fieldAsset || `assets/corridors/${id}.PNG`,
      `assets/projectiles/${id}.PNG`,
      `assets/obstacles/${id}_0.PNG`, `assets/obstacles/${id}_1.PNG`,
      `assets/ui/origin-rings/${id}.PNG`
    );
  });
  DB.TOWERS.forEach((tw) => { paths.push(tw.asset || `assets/towers/${tw.id}.PNG`); if (tw.assetProjectile) paths.push(tw.assetProjectile); });
  Object.keys(DB.ENEMIES).forEach((id) => { const e = DB.ENEMIES[id]; paths.push(e.asset || `assets/enemies/${id}.PNG`); });
  Object.keys(DB.STATUSES).forEach((id) => { const st = DB.STATUSES[id]; paths.push(st.asset || `assets/status/${id}.PNG`); });
  return paths;
}

export default { createAssets, collectPreloadAssets };
