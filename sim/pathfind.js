/* =============================================================================
 * Circle Tower Wars — sim/pathfind.js
 * BFS / Dijkstra FLOW FIELD (§3 rule 3 — integer distances, deterministic).
 *
 * Each corridor keeps a `dist` field: integer cost-to-exit for every cell,
 * computed with INTEGER step costs (orthogonal = 10, diagonal = 14 ≈ 10·√2).
 * Enemies always step toward the lowest-distance neighbor, so movement is
 * deterministic and engine-independent. No floats, no Math.* here.
 *
 * Grid cell codes: 0 = free, 1 = obstacle, 2 = tower-occupied.
 * ===========================================================================*/

export const INF = 0x3fffffff;
export const COST_ORTHO = 10;
export const COST_DIAG = 14;

// 8-neighbour offsets in a FIXED order (never reorder — hash stability).
export const NB = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export function makeGrid(cols, rows) {
  return new Uint8Array(cols * rows); // all free
}

export function blocked(grid, cols, rows, c, r) {
  if (c < 0 || r < 0 || c >= cols || r >= rows) return true;
  return grid[r * cols + c] !== 0;
}

/**
 * Compute integer flow field (cost to exit). Uses a Dijkstra-style relaxation
 * with a simple array queue; deterministic because the queue is processed in
 * insertion order and neighbours in fixed NB order.
 */
export function computeFlow(corr, cols, rows) {
  const dist = corr.dist || (corr.dist = new Int32Array(cols * rows));
  dist.fill(INF);
  const grid = corr.grid;
  const idx = (c, r) => r * cols + c;
  const ex = corr.exit;
  const q = [];
  let head = 0;
  dist[idx(ex.c, ex.r)] = 0;
  q.push(ex.c, ex.r);
  while (head < q.length) {
    const c = q[head++], r = q[head++];
    const d = dist[idx(c, r)];
    for (let k = 0; k < NB.length; k++) {
      const dc = NB[k][0], dr = NB[k][1];
      const nc = c + dc, nr = r + dr;
      if (blocked(grid, cols, rows, nc, nr)) continue;
      // prevent diagonal corner-cutting through two blocked orthogonals
      if (dc !== 0 && dr !== 0 &&
          blocked(grid, cols, rows, c + dc, r) &&
          blocked(grid, cols, rows, c, r + dr)) continue;
      const step = (dc !== 0 && dr !== 0) ? COST_DIAG : COST_ORTHO;
      const nd = d + step;
      if (nd < dist[idx(nc, nr)]) {
        dist[idx(nc, nr)] = nd;
        q.push(nc, nr);
      }
    }
  }
  return dist;
}

export function reachable(corr, cols) {
  return corr.dist[corr.entrance.r * cols + corr.entrance.c] < INF;
}

// Best lower-distance neighbour cell for a given cell, or null if none.
export function bestNeighbor(corr, cols, rows, c, r) {
  const dist = corr.dist, grid = corr.grid;
  const idx = (cc, rr) => rr * cols + cc;
  let best = null, bestD = dist[idx(c, r)];
  for (let k = 0; k < NB.length; k++) {
    const dc = NB[k][0], dr = NB[k][1];
    const nc = c + dc, nr = r + dr;
    if (blocked(grid, cols, rows, nc, nr)) continue;
    if (dc !== 0 && dr !== 0 &&
        blocked(grid, cols, rows, c + dc, r) &&
        blocked(grid, cols, rows, c, r + dr)) continue;
    const d = dist[idx(nc, nr)];
    if (d < bestD) { bestD = d; best = k; }
  }
  return best; // index into NB, or null
}

export default { INF, COST_ORTHO, COST_DIAG, NB, makeGrid, blocked, computeFlow, reachable, bestNeighbor };
