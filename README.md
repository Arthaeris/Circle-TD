# Circle Tower Wars — rebuilt engine (v2)

This is the implementation of `Anweisungen.md`: a DOM/Canvas‑free **deterministic
fixed‑point sim‑core**, a **fixed simulation tick** with free render rate, **seeded
RNG**, **autosave per wave**, a **lockstep** netcode layer with **state‑hash
desync detection** and **content‑gating**, **co‑op / competitive** modes with the
**send‑economy**, and **PWA / offline** support — split along the module boundary
the spec defines (§2). In‑game text stays English.

## Run it

No build is required — the browser loads the ES modules directly.

1. Serve the folder over http (modules + service worker need http, not `file://`):
   `npx serve .`  (or any static server), then open **`index.html`**.

Optional production bundle: `npm install && npm run build` → `dist/ctw.min.js`.

## Verify it (the important part)

The deterministic core and netcode are **proven in Node** — this is the property
lockstep stands or falls on (§6.4 / §11):

```
npm test          # or: node tests/run-all.mjs
```

- `test-fx-rng` — fixed‑point math, isqrt/sqrt, trig LUT, dual seeded RNG, hashing (22 checks)
- `test-determinism` — **same seed + same commands ⇒ identical state hash at every checkpoint** across two independent runs; different seed diverges (7 checks)
- `test-lockstep` — two independent "clients" exchanging **only inputs** reach identical hashes with **no desync** over a full 2400‑tick match (5 checks)
- `test-content-gate` — stable content hash; tampered balancing changes the hash (6 checks)

All 40 checks pass.

## File map (§2 module boundary)

```
sim/      pure deterministic core — NO document/canvas/Date/Math.random
  fx.js         16.16 fixed‑point math, isqrt, sin/cos/atan2 LUTs (§3, D9)
  rng.js        mulberry32, two streams: sim (seeded) + cosmetic (§5, D5)
  hash.js       FNV‑1a state hash + content hash (§6.4)
  pathfind.js   integer BFS flow field — deterministic movement (§3 rule 3)
  waves.js      deterministic wave generation + enemy scaling
  balance.js    converts database.js → fixed‑point balancing table (§3/§8.4)
  core.js       createState + step(state, commands, SIM_DT) — ALL players' fields,
                combat, statuses, synergies, economy, send‑economy (§2/§7/§8, D10)
net/
  commands.js   command schema + deterministic ordering + wire (de)serialize (§6.1)
  lockstep.js   input‑delay tick loop, input buffer, stall, hash checkpoints (§6.2/§6.4/§6.5)
  firebase.js   Firebase RTDB transport + lobby + content‑gating handshake (§6.3)
render/
  assets.js     image cache + preloader (.PNG, D1)
  draw.js       canvas renderer (world + field) with interpolation alpha (§4)
ui/
  shell.js      panels, HUD, setup menu, toasts — emits commands, never mutates state
app/
  loop.js       accumulator: fixed SIM_DT + free render fps + alpha (§4, D4)
  main.js       orchestrator: boot, input→commands, solo + lockstep drivers,
                autosave (§9), PWA register (§10), render‑fps preference
database.js       original content library (unchanged)
database-ext.js   adds GAME_MODES + COMPETITIVE economy + version fields (§8/§6.4)
save.js           original save layer (unchanged; autosave is triggered by app/main.js)
mobile.css        touch targets, safe‑areas, long‑session ergonomics
manifest.json     PWA manifest (§10, D2)
sw.js             service worker, versioned cache‑first (§10, D2)
index.html         NEW entry point with the module load order
systems.legacy.js the original monolithic engine, kept for reference only
```

## How each decision was implemented

| Decision | Where |
|---|---|
| D1 `.PNG` uppercase everywhere | `render/assets.js`, `index.html`, `sw.js` — no lowercase `.png` anywhere |
| D2 Offline via SW + manifest | `sw.js`, `manifest.json`, registration in `app/main.js` |
| D3 Autosave after every wave | `core.js` emits a `waveClear{autosave:true}` event → `app/main.js` `autosave()` |
| D4 Fixed sim tick, free render fps | `app/loop.js` accumulator + `alpha`; `draw.js` interpolates enemy positions |
| D5 Seeded RNG, two streams | `sim/rng.js`; sim stream lives in `state.seedSim`, cosmetic stays out of the core |
| D6 Lockstep (inputs only) | `net/lockstep.js` + `net/commands.js` + `net/firebase.js` |
| D7 DOM/Canvas‑free sim‑core | `sim/*` import nothing from the DOM; enforced by Node tests running headless |
| D8 Co‑op + Competitive | `core.js` `gameMode`; co‑op shares `coopLives`, competitive separates fields |
| D9 Fixed‑point cross‑engine | `sim/fx.js` everywhere in the core; no `Math.sin/sqrt/...` in state code |
| D10 2–8 players | `createState` builds N player fields; lobby assigns slots 0..7 |
| D11 Send builds passive income | `cmdSendEnemy` adds `incomePerSend`; `updateIncome` pays out |
| D12 Fixed (non‑rising) sent bounty | `killEnemy` applies `sentBountyMult` once — never scales per sent enemy |
| Anti‑snowball (§8.3) | rising send cost (`sendCostGrowth`) + catch‑up income, **not** the bounty |

## What is verified vs. what still needs a device

**Verified headlessly (Node):** the fixed‑point math, RNG, hashing, the whole
sim‑core step (waves, movement, combat, statuses, synergies, economy,
send‑economy), command application/ordering, the lockstep loop, and
content‑gating. Two independent simulations stay bit‑identical — the Safari↔Chrome
guarantee the design needs.

**Needs a browser pass (cannot be tested here):** the canvas rendering and DOM UI
in `render/` + `ui/`, asset loading, touch input, and a live 2‑device Firebase
match. The renderer/UI were rebuilt to read the new state and follow the original's
visual structure, but pixels and live multiplayer should be smoke‑tested on a phone
+ desktop before release. Wave‑clear autosave, the fixed timestep, and the
solo→core wiring are exercised by the headless tests via the same `step()`.

## Notes
- For GitHub deployment specifics see DEPLOY.md.
- `net/firebase.js` needs your real Firebase config (the apiKey shows "redacted").
- The competitive anti-snowball lever is **rising send cost + catch-up income**
  (the open §8.3 choice), chosen because it does not touch the D12 defender bounty.
  Change the numbers in `database-ext.js -> COMPETITIVE`.
