/* =============================================================================
 * Circle Tower Wars — app/loop.js
 * FIXED SIM TICK + FREE RENDER RATE (Decision D4, §4).
 *
 * Two independent rates:
 *   - Sim tick: a FIXED timestep (SIM_DT). In multiplayer it is identical for
 *     everyone and not user-adjustable.
 *   - Render rate: a purely local preference (e.g. 30/45/60 fps) for battery
 *     saving; it never touches game state.
 *
 * Classic accumulator loop. Each rendered frame we run as many whole sim ticks
 * as real time has accrued, then draw with an interpolation factor `alpha` so
 * motion looks smooth even at a low chosen fps. The sim itself lives behind
 * `onTick` (single-player: step the core directly; multiplayer: the lockstep
 * layer decides which ticks are ready).
 * ===========================================================================*/

import * as fx from "../sim/fx.js";

// Sim runs at a fixed 30 Hz (must match sim/core.js SIM_HZ).
const SIM_HZ = 30;

export const SIM_DT_SEC = 1 / SIM_HZ;           // real seconds per sim tick
export const SIM_DT_FX = fx.fromFloat(SIM_DT_SEC); // fixed-point seconds for step()

export function createLoop(opts) {
  const onTick = opts.onTick;           // (SIM_DT_FX) => void  — advance one sim tick
  const onRender = opts.onRender;       // (alpha 0..1) => void — draw interpolated
  const isRunning = opts.isRunning || (() => true);
  const maxTicksPerFrame = opts.maxTicksPerFrame || 5; // avoid spiral of death

  let renderFps = opts.renderFps || 45; // local-only preference
  let renderInterval = 1000 / renderFps;
  let accumulator = 0;                  // seconds of un-simulated real time
  let lastT = 0;
  let lastRenderT = 0;
  let rafId = null;
  let running = false;

  function setRenderFps(fps) {
    renderFps = Math.max(15, Math.min(120, fps | 0));
    renderInterval = 1000 / renderFps;
  }

  function frame(t) {
    const dtReal = Math.min(0.05, (t - lastT) / 1000 || 0); // clamp big gaps
    lastT = t;

    if (isRunning()) {
      accumulator += dtReal;
      let ticks = 0;
      while (accumulator >= SIM_DT_SEC && ticks < maxTicksPerFrame) {
        onTick(SIM_DT_FX);
        accumulator -= SIM_DT_SEC;
        ticks++;
      }
      // if we blew the budget, drop the backlog rather than freeze
      if (accumulator > SIM_DT_SEC * maxTicksPerFrame) accumulator = 0;
    }

    // Throttle drawing to the chosen render fps; interpolate with alpha.
    if (t - lastRenderT >= renderInterval) {
      lastRenderT = t;
      const alpha = Math.max(0, Math.min(1, accumulator / SIM_DT_SEC));
      onRender(alpha);
    }

    if (running) rafId = requestAnimationFrame(frame);
  }

  return {
    start() { if (running) return; running = true; lastT = performance.now(); lastRenderT = lastT; rafId = requestAnimationFrame(frame); },
    stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; },
    setRenderFps,
    get renderFps() { return renderFps; },
    SIM_DT_FX,
    SIM_DT_SEC,
  };
}

export default { createLoop, SIM_DT_FX, SIM_DT_SEC };
