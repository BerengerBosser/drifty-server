/* ═══════════════════════════════════════════════════════════════════════════
   server.js — Drifty Authoritative WebSocket Server

   - Express pour health check (Render.com)
   - WebSocket (ws) pour le jeu
   - Rooms avec gestion d'état par mode de jeu
   - Protocole binaire pour les positions, JSON pour le lobby
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Room = require('./room');
const { MSG, SERV } = require('./protocol');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                          // Hz — serveur → clients
const TICK_MS = 1000 / TICK_RATE;
const MAX_ROOMS = 100;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/1/O/0

// Logs de debug verbeux (un par message) — actifs seulement si DRIFTY_DEBUG=1,
// pour ne pas polluer les logs de prod sur Render.
const DEBUG = process.env.DRIFTY_DEBUG === '1';
function dbg(...args) { if (DEBUG) console.log(...args); }

function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Validation basique des payloads reçus (name/photo sont des chaînes
// contrôlées par le client puis rediffusées telles quelles à toute la room).
function sanitizeName(name) {
  const s = (typeof name === 'string' ? name : '').trim().slice(0, 24);
  return s || 'Joueur';
}
function sanitizePhoto(photo) {
  return (typeof photo === 'string' && photo.length > 0 && photo.length <= 300000) ? photo : null;
}

// ── Express (health check) ──────────────────────────────────────────────
const app = express();
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});
app.get('/rooms', (_req, res) => {
  const list = [];
  for (const [code, room] of rooms) {
    list.push({ code, players: room.players.size, mode: room.gameMode, phase: room.phase });
  }
  res.json(list);
});

const server = http.createServer(app);

// ── WebSocket ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const rooms = new Map();    // code → Room
const wsToRoom = new WeakMap();  // ws → Room
const wsToPlayerId = new WeakMap(); // ws → playerId

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function sendJSON(ws, data) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (e) {}
  }
}

function sendBinary(ws, buf) {
  if (ws && ws.readyState === 1) {
    try { ws.send(buf); } catch (e) {}
  }
}

function broadcastJSON(room, data, excludeWs) {
  const str = JSON.stringify(data);
  for (const [pid, player] of room.players) {
    if (player.ws && player.ws !== excludeWs && player.ws.readyState === 1) {
      try { player.ws.send(str); } catch (e) {}
    }
  }
}

function broadcastBinary(room, buf, excludeWs) {
  for (const [pid, player] of room.players) {
    if (player.ws && player.ws !== excludeWs && player.ws.readyState === 1) {
      try { player.ws.send(buf); } catch (e) {}
    }
  }
}

// Branche les événements d'une room fraîchement créée : une fois le délai de
// grâce de reconnexion écoulé sans reprise (Room.markDisconnected /
// _finalizeRemoval), on prévient le reste de la room — comportement
// équivalent à l'ancien retrait immédiat, juste différé pour laisser une
// chance à une coupure réseau temporaire de se rétablir.
function wireRoomEvents(room) {
  room.on('playerRemoved', (playerId) => {
    broadcastJSON(room, { type: 'roster', roster: room.getRoster() });
    if (playerId === 'host') {
      broadcastJSON(room, { type: 'hostLeft' });
    }
  });
}

// ── Connection handling ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    try {
      if (isBinary) {
        handleBinary(ws, raw);
      } else {
        handleJSON(ws, JSON.parse(raw.toString()));
      }
    } catch (e) {
      console.error('Message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    const room = wsToRoom.get(ws);
    const playerId = wsToPlayerId.get(ws);
    if (room && playerId) {
      // Ne libère pas le slot tout de suite : laisse un délai de grâce pour
      // une reconnexion (rejoinRoom) avant de retirer réellement le joueur
      // et de prévenir le reste de la room (voir wireRoomEvents ci-dessus).
      room.markDisconnected(playerId);
      wsToRoom.delete(ws);
      wsToPlayerId.delete(ws);
      // Signale immédiatement le passage en "reconnecting" dans le roster
      // (getRoster() expose `disconnected: true`), sans encore retirer le
      // joueur ni annoncer hostLeft.
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() });
    }
  });
});

// ── JSON messages (lobby + events) ──────────────────────────────────────
function handleJSON(ws, msg) {
  if (msg.type !== 'state' && msg.type !== 'ping') dbg('[DRIFTY-DBG] Server ← JSON:', msg.type, 'from=' + (wsToPlayerId.get(ws) || '?'));
  switch (msg.type) {
    case 'createRoom': {
      if (rooms.size >= MAX_ROOMS) {
        sendJSON(ws, { type: 'error', msg: 'Serveur saturé, réessaie.' });
        return;
      }
      const code = generateRoomCode();
      msg.name = sanitizeName(msg.name);
      msg.photo = sanitizePhoto(msg.photo);
      const hostToken = generateSessionToken();
      const room = new Room(code, ws, msg, hostToken);
      // Apply host customization from createRoom payload
      if (msg.photo) room.updatePlayerCosmetic('host', msg);
      rooms.set(code, room);
      wireRoomEvents(room);
      wsToRoom.set(ws, room);
      wsToPlayerId.set(ws, 'host');
      dbg('[DRIFTY-DBG] Server: room created, code=' + code + ' hostName=' + msg.name);
      sendJSON(ws, { type: 'roomCreated', code, sessionToken: hostToken });
      break;
    }

    case 'joinRoom': {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        sendJSON(ws, { type: 'error', msg: 'Room introuvable.' });
        return;
      }
      if (room.players.size >= 4) {
        sendJSON(ws, { type: 'full' });
        return;
      }
      if (room.phase !== 'lobby') {
        sendJSON(ws, { type: 'error', msg: 'La partie a déjà commencé.' });
        return;
      }
      msg.name = sanitizeName(msg.name);
      msg.photo = sanitizePhoto(msg.photo);
      const playerId = 'p_' + Math.random().toString(36).slice(2, 10);
      const token = generateSessionToken();
      room.addPlayer(playerId, ws, msg, token);
      wsToRoom.set(ws, room);
      wsToPlayerId.set(ws, playerId);
      dbg('[DRIFTY-DBG] Server: player joined, code=' + code + ' playerId=' + playerId + ' name=' + msg.name + ' gameMode=' + room.gameMode);
      // Send welcome to this player
      sendJSON(ws, {
        type: 'welcome',
        selfId: playerId,
        slot: room.getPlayerSlot(playerId),
        code,
        ...room.getSettings(),
        roster: room.getRoster(),
        phase: room.phase,
        sessionToken: token,
      });
      // Broadcast updated roster
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() }, ws);
      break;
    }

    case 'rejoinRoom': {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { sendJSON(ws, { type: 'error', code: 'rejoin_failed', msg: 'Room introuvable.' }); return; }
      const playerId = room.reclaimPlayer(msg.token, ws);
      if (!playerId) { sendJSON(ws, { type: 'error', code: 'rejoin_failed', msg: 'Reconnexion impossible.' }); return; }
      wsToRoom.set(ws, room);
      wsToPlayerId.set(ws, playerId);
      dbg('[DRIFTY-DBG] Server: player rejoined, code=' + code + ' playerId=' + playerId);
      sendJSON(ws, {
        type: 'rejoined',
        selfId: playerId,
        slot: room.getPlayerSlot(playerId),
        code,
        ...room.getSettings(),
        roster: room.getRoster(),
        phase: room.phase,
      });
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() }, ws);
      break;
    }

    case 'settings':
    case 'roomSettings': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      dbg('[DRIFTY-DBG] Server: settings received, gameMode=' + msg.gameMode + ' trackMode=' + msg.trackMode + ' speedClass=' + msg.speedClass);
      room.updateSettings(msg);
      broadcastJSON(room, { type: 'settings', ...room.getSettings() }, ws);
      break;
    }

    case 'startRace': {
      const room = wsToRoom.get(ws);
      if (!room) { dbg('[DRIFTY-DBG] Server: startRace received but no room!'); return; }
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') { dbg('[DRIFTY-DBG] Server: startRace from non-host:', playerId); return; }
      dbg('[DRIFTY-DBG] Server: startRace from host, gameMode=' + room.gameMode + ' phase=' + room.phase + ' players=' + room.players.size);
      room.startRace(msg);
      break;
    }

    case 'customize': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      room.updatePlayerCosmetic(playerId, msg);
      broadcastJSON(room, { type: 'customize', id: playerId, color: msg.color, carStyle: msg.carStyle, photo: msg.photo }, ws);
      break;
    }

    case 'emote': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      broadcastJSON(room, { type: 'emote', id: playerId, emoji: msg.emoji, name: msg.name }, ws);
      break;
    }

    case 'socHit': {
      // Foot Arena reste hôte-autoritaire (voir room.js startRace) : la balle
      // n'est simulée que côté hôte, donc la frappe doit lui être transmise
      // (comme gsReady) plutôt que traitée ici — room.onSoccerHit() est un
      // no-op tant que SoccerMode n'est pas branchée.
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      room.onSoccerHit(playerId);
      const hostPlayer = room.players.get('host');
      if (hostPlayer && hostPlayer.ws && hostPlayer.ws !== ws) {
        sendJSON(hostPlayer.ws, { type: 'socHit', id: playerId });
      }
      break;
    }

    case 'sumoOut': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      room.onSumoOut(playerId);
      break;
    }

    case 'dropBanana': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      broadcastJSON(room, {
        type: 'dropBanana', ownerId: playerId,
        id: msg.id, x: msg.x, y: msg.y, fromX: msg.fromX, fromY: msg.fromY,
        angle: msg.angle, radius: msg.radius,
      }, ws);
      break;
    }

    case 'removeBanana': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      broadcastJSON(room, { type: 'removeBanana', id: playerId, ids: msg.ids || [] }, ws);
      break;
    }

    case 'reset': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      room.resetToLobby();
      break;
    }

    case 'addBot': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      room.addBot();
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() });
      break;
    }

    case 'removeBot': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      room.removeBot();
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() });
      break;
    }

    case 'ping': {
      sendJSON(ws, { type: 'pong', t: msg.t || Date.now() });
      break;
    }

    // Draw mode
    case 'trackSubmit': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      broadcastJSON(room, { type: 'trackSubmit', id: playerId, pts: msg.pts }, ws);
      break;
    }

    // Grand Slam — relay to host
    case 'gsReady': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      const hostPlayer = room.players.get('host');
      if (hostPlayer && hostPlayer.ws) {
        sendJSON(hostPlayer.ws, { type: 'gsReady', id: playerId });
      }
      break;
    }

    // JSON state updates (client sends JSON, not binary)
    case 'state': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (!playerId) return;
      room.onPlayerStateJSON(playerId, msg);
      break;
    }

    // Passthrough générique : plusieurs modes (dessin, grand chelem, foot)
    // reposent encore sur le modèle P2P où l'hôte pousse lui-même l'état de
    // la partie via des messages qui n'ont pas (encore) d'implémentation
    // serveur dédiée (drawStart, trackPool, roulette, gsInit, gsPick,
    // gsResult, socStart, socSnap, socRound…). Sans ce relais générique, ces
    // messages étaient silencieusement avalés par ce switch (aucun 'case'
    // ne correspond) et ne parvenaient jamais aux autres joueurs. On les
    // relaie donc tels quels à tout le reste de la room, comme le faisait
    // l'ancien hôte P2P (Network._relay).
    default: {
      const room = wsToRoom.get(ws);
      if (!room) return;
      broadcastJSON(room, msg, ws);
      break;
    }
  }
}

// ── Binary messages (gameplay state) ────────────────────────────────────
function handleBinary(ws, buf) {
  const room = wsToRoom.get(ws);
  if (!room) return;
  const playerId = wsToPlayerId.get(ws);
  if (!playerId) return;

  const type = buf[0];
  switch (type) {
    case MSG.STATE:
    case MSG.STATE_PAINT:
    case MSG.STATE_SUMO:
    case MSG.STATE_SOCCER:
      room.onPlayerState(playerId, buf);
      break;
    case MSG.SOC_HIT:
      room.onSoccerHit(playerId);
      break;
    case MSG.SUMO_OUT:
      room.onSumoOut(playerId);
      break;
    case MSG.BANANA_DROP:
      broadcastBinary(room, buf, ws);
      break;
    case MSG.BANANA_REMOVE:
      broadcastBinary(room, buf, ws);
      break;
  }
}

// ── Game tick ───────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Clean up empty rooms (after 2 min)
    if (room.players.size === 0) {
      if (now - room.emptySince > 120000) {
        rooms.delete(code);
      }
      continue;
    }
    room.tick(now);
  }
}, TICK_MS);

// ── Heartbeat (detect dead connections) ─────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Drifty server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// Render envoie SIGTERM à chaque redeploy/restart. Sans ça, les rooms en
// cours meurent sans prévenir (le client ne verra qu'une coupure sèche).
// On prévient les joueurs, puis on laisse un court délai pour que le message
// parte avant de fermer réellement le serveur.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, notifying ${rooms.size} room(s)...`);
  for (const [, room] of rooms) {
    broadcastJSON(room, { type: 'serverRestart' });
  }
  clearInterval(heartbeat);
  setTimeout(() => {
    server.close(() => process.exit(0));
    // Filet de sécurité si des sockets WS bloquent la fermeture du serveur HTTP.
    setTimeout(() => process.exit(0), 2000);
  }, 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
