/* =============================================================================
 * Circle Tower Wars — net/firebase.js
 * Firebase Realtime Database transport (§6.3) — the multiplayer module for the
 * rebuilt engine. Supersedes the original firebase-multiplayer.js: it keeps the
 * same lobby API (so the existing menu buttons work) AND adds the LOCKSTEP
 * transport (per-tick input fan-out + state-hash exchange + content-gating).
 *
 * Loaded as an ES module; publishes window.CTWMultiplayer.
 *
 * SECURITY: the apiKey is a public web client identifier (normal for Firebase).
 * Protect data with Realtime Database Security Rules, not by hiding the key.
 * ===========================================================================*/
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getDatabase, ref, set, update, get, onValue, onChildAdded,
  serverTimestamp, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "redacted",
  authDomain: "circle-tower-defense.firebaseapp.com",
  databaseURL: "https://circle-tower-defense-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "circle-tower-defense",
  storageBucket: "circle-tower-defense.firebasestorage.app",
  messagingSenderId: "282045666455",
  appId: "1:282045666455:web:deb28ec05ff5748057c5d2"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

window.CTWMultiplayer = {
  // ---- lobby (compatible with the original menu buttons) ------------------
  createTestRoom(roomId) {
    return set(ref(db, `rooms/${roomId}`), { createdAt: serverTimestamp(), message: "Room created", players: {} });
  },
  createRoom(roomId, playerId, gate) {
    return set(ref(db, `rooms/${roomId}`), {
      createdAt: serverTimestamp(),
      status: "lobby",
      host: playerId,
      gate: gate || null,                 // {codeVersion, contentHash, seed, mode, gameMode}
      players: { [playerId]: { role: "host", ready: false, slot: 0, joinedAt: Date.now() } }
    });
  },
  async joinRoom(roomId, playerId) {
    const snap = await get(ref(db, `rooms/${roomId}/players`));
    const players = snap.val() || {};
    const slot = Object.keys(players).length;       // next free slot (0..7, D10)
    await set(ref(db, `rooms/${roomId}/players/${playerId}`), { role: "guest", ready: false, slot, joinedAt: Date.now() });
    onDisconnect(ref(db, `rooms/${roomId}/players/${playerId}`)).remove();
    return slot;
  },
  setReady(roomId, playerId, ready) { return set(ref(db, `rooms/${roomId}/players/${playerId}/ready`), ready); },
  setRoomStatus(roomId, status) { return set(ref(db, `rooms/${roomId}/status`), status); },
  setMatchStart(roomId, payload) { return update(ref(db, `rooms/${roomId}`), { status: "running", match: payload }); },
  watchRoom(roomId, cb) { return onValue(ref(db, `rooms/${roomId}`), s => cb(s.val())); },
  watchTestRoom(roomId, cb) { return onValue(ref(db, `rooms/${roomId}`), s => cb(s.val())); },

  // Content-gating check (§6.4): join only if code version + content hash match.
  gateOk(localGate, roomGate) {
    if (!roomGate) return true;
    return localGate.codeVersion === roomGate.codeVersion &&
           localGate.contentHash === roomGate.contentHash;
  },

  // ---- lockstep transport (§6.2/§6.4) -------------------------------------
  // Inputs and hashes live under rooms/<id>/net. Each player writes only its own
  // lane; clients read all lanes. Returns a transport for createLockstep().
  makeTransport(roomId, localPlayer) {
    const inputCbs = [], hashCbs = [];
    const base = `rooms/${roomId}/net`;
    onChildAdded(ref(db, `${base}/inputs`), (lane) => {
      const player = Number(lane.key);
      onChildAdded(ref(db, `${base}/inputs/${player}`), (snap) => {
        inputCbs.forEach(fn => fn(Number(snap.key), player, snap.val() || []));
      });
    });
    onChildAdded(ref(db, `${base}/hash`), (lane) => {
      const player = Number(lane.key);
      onChildAdded(ref(db, `${base}/hash/${player}`), (snap) => {
        hashCbs.forEach(fn => fn(Number(snap.key), player, snap.val()));
      });
    });
    return {
      sendInputs: (turn, commands) => set(ref(db, `${base}/inputs/${localPlayer}/${turn}`), commands),
      onInputs: (cb) => inputCbs.push(cb),
      sendHash: (turn, hash) => set(ref(db, `${base}/hash/${localPlayer}/${turn}`), hash),
      onHash: (cb) => hashCbs.push(cb),
      pruneInputs: (beforeTurn) => { remove(ref(db, `${base}/inputs/${localPlayer}/${beforeTurn}`)); remove(ref(db, `${base}/hash/${localPlayer}/${beforeTurn}`)); },
    };
  },

  leaveRoom(roomId, playerId) { return remove(ref(db, `rooms/${roomId}/players/${playerId}`)); },
};
