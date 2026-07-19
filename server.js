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
const { WebSocketServer } = require('ws');
const Room = require('./room');
const { MSG, SERV } = require('./protocol');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                          // Hz — serveur → clients
const TICK_MS = 1000 / TICK_RATE;
const MAX_ROOMS = 100;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/1/O/0

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
  for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function sendJSON(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (e) {}
  }
}

function sendBinary(ws, buf) {
  if (ws.readyState === 1) {
    try { ws.send(buf); } catch (e) {}
  }
}

function broadcastJSON(room, data, excludeWs) {
  const str = JSON.stringify(data);
  for (const [pid, player] of room.players) {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      try { player.ws.send(str); } catch (e) {}
    }
  }
}

function broadcastBinary(room, buf, excludeWs) {
  for (const [pid, player] of room.players) {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      try { player.ws.send(buf); } catch (e) {}
    }
  }
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
      room.removePlayer(playerId);
      wsToRoom.delete(ws);
      wsToPlayerId.delete(ws);
      // Notify remaining players
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() });
      // If host left, notify (room will be cleaned up on next tick if empty)
      if (playerId === 'host') {
        broadcastJSON(room, { type: 'hostLeft' });
      }
    }
  });
});

// ── JSON messages (lobby + events) ──────────────────────────────────────
function handleJSON(ws, msg) {
  switch (msg.type) {
    case 'createRoom': {
      if (rooms.size >= MAX_ROOMS) {
        sendJSON(ws, { type: 'error', msg: 'Serveur saturé, réessaie.' });
        return;
      }
      const code = generateRoomCode();
      const room = new Room(code, ws, msg);
      rooms.set(code, room);
      wsToRoom.set(ws, room);
      wsToPlayerId.set(ws, 'host');
      sendJSON(ws, { type: 'roomCreated', code });
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
      const playerId = 'p_' + Math.random().toString(36).slice(2, 10);
      room.addPlayer(playerId, ws, msg);
      wsToRoom.set(ws, room);
      wsToPlayerId.set(ws, playerId);
      // Send welcome to this player
      sendJSON(ws, {
        type: 'welcome',
        selfId: playerId,
        slot: room.getPlayerSlot(playerId),
        code,
        ...room.getSettings(),
        roster: room.getRoster(),
        phase: room.phase,
      });
      // Broadcast updated roster
      broadcastJSON(room, { type: 'roster', roster: room.getRoster() }, ws);
      break;
    }

    case 'settings': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      room.updateSettings(msg);
      broadcastJSON(room, { type: 'settings', ...room.getSettings() }, ws);
      break;
    }

    case 'startRace': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      if (playerId !== 'host') return;
      room.startRace(msg);
      break;
    }

    case 'customize': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      room.updatePlayerCosmetic(playerId, msg);
      broadcastJSON(room, { type: 'customize', id: playerId, color: msg.color, carStyle: msg.carStyle }, ws);
      break;
    }

    case 'emote': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      broadcastJSON(room, { type: 'emote', id: playerId, emote: msg.emote }, ws);
      break;
    }

    case 'socHit': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      const playerId = wsToPlayerId.get(ws);
      room.onSoccerHit(playerId);
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
      broadcastJSON(room, { type: 'dropBanana', id: playerId, x: msg.x, y: msg.y, angle: msg.angle }, ws);
      break;
    }

    case 'removeBanana': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      broadcastJSON(room, { type: 'removeBanana', id: msg.id, idx: msg.idx }, ws);
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

    // Grand Slam
    case 'gsReady': {
      const room = wsToRoom.get(ws);
      if (!room) return;
      room.onGsReady(wsToPlayerId.get(ws));
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
