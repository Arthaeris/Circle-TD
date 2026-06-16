/* =============================================================================
 * Circle Tower Wars — net/commands.js
 * COMMAND SCHEMA + ordering (§6.1).
 *
 * Commands carry INTENT only — never results. They are tick-stamped and, when
 * a tick is executed, sorted into a single deterministic order (by player, then
 * by per-player sequence) so every client feeds step() the identical array.
 * ===========================================================================*/

export const CommandTypes = [
  "BuildTower", "SellTower", "UpgradeTower", "MutateTower",
  "StartWave", "SendEnemy", "SetSpeed", "Ack",
];

// Factory helpers (the shell builds these from local input, never mutating state).
export function buildTower(player, corridorId, gx, gy, towerType, masteryLevel) {
  return { type: "BuildTower", player, corridorId, gx, gy, towerType, masteryLevel };
}
export function sellTower(player, corridorId, towerId) {
  return { type: "SellTower", player, corridorId, towerId };
}
export function upgradeTower(player, corridorId, towerId) {
  return { type: "UpgradeTower", player, corridorId, towerId };
}
export function mutateTower(player, corridorId, towerId, mutId, masteryLevel) {
  return { type: "MutateTower", player, corridorId, towerId, mutId, masteryLevel };
}
export function startWave(player) { return { type: "StartWave", player }; }
export function sendEnemy(player, target, enemyType) { return { type: "SendEnemy", player, target, enemyType }; }
export function setSpeed(player, speed) { return { type: "SetSpeed", player, speed }; }
export function ack(player) { return { type: "Ack", player }; }

// Deterministic ordering of a tick's commands. `seq` is a monotonically
// increasing per-emit counter assigned by the lockstep layer; ties (same
// player+seq, impossible in practice) fall back to type index.
export function orderCommands(cmds) {
  return cmds.slice().sort((a, b) => {
    if (a.player !== b.player) return a.player - b.player;
    if ((a.seq | 0) !== (b.seq | 0)) return (a.seq | 0) - (b.seq | 0);
    return CommandTypes.indexOf(a.type) - CommandTypes.indexOf(b.type);
  });
}

// Compact wire serialization (Firebase RTDB is happy with plain JSON; this just
// strips undefined and keeps payloads small).
export function serialize(cmds) {
  return cmds.map(c => {
    const o = { t: c.type, p: c.player };
    if (c.corridorId != null) o.c = c.corridorId;
    if (c.gx != null) o.x = c.gx;
    if (c.gy != null) o.y = c.gy;
    if (c.towerType != null) o.w = c.towerType;
    if (c.towerId != null) o.i = c.towerId;
    if (c.mutId != null) o.m = c.mutId;
    if (c.target != null) o.g = c.target;
    if (c.enemyType != null) o.e = c.enemyType;
    if (c.masteryLevel != null) o.l = c.masteryLevel;
    if (c.speed != null) o.sp = c.speed;
    if (c.seq != null) o.s = c.seq;
    return o;
  });
}
export function deserialize(arr) {
  return (arr || []).map(o => ({
    type: o.t, player: o.p, corridorId: o.c, gx: o.x, gy: o.y, towerType: o.w,
    towerId: o.i, mutId: o.m, target: o.g, enemyType: o.e, masteryLevel: o.l, speed: o.sp, seq: o.s,
  }));
}

export default {
  CommandTypes, buildTower, sellTower, upgradeTower, mutateTower,
  startWave, sendEnemy, setSpeed, ack, orderCommands, serialize, deserialize,
};
