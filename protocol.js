/* ═══════════════════════════════════════════════════════════════════════════
   protocol.js — Définition des messages réseau binaires Drifty

   Les messages fréquents (positions, snapshots) utilisent ArrayBuffer pour
   minimiser la bande passante. Les messages de lobby (roster, settings)
   restent en JSON car ils sont peu fréquents.

   Tous les types de message sont définis ici comme constantes. Le premier
   octet de tout message binaire est le "type byte".
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Message types (client → server) ──────────────────────────────────────
const MSG = {
  // Lobby
  JOIN:           0x01,   // { name, photo?, stats?, cloudId? }
  CREATE_ROOM:    0x02,   // { name, settings }
  SETTINGS:       0x03,   // lobby settings changed by host
  START_RACE:     0x04,   // host requests race start
  CUSTOMIZE:      0x05,   // color / car style change
  EMOTE:          0x06,   // quick chat
  CHAT:           0x07,   // free text chat

  // Gameplay — binary
  STATE:          0x20,   // position update (15 bytes)
  STATE_PAINT:    0x21,   // position update for paint mode (11 bytes)
  STATE_SUMO:     0x22,   // position + velocity + dash/charge (25 bytes)
  STATE_SOCCER:   0x23,   // position for soccer (11 bytes)

  // Gameplay — events (binary)
  SOC_HIT:        0x30,   // soccer kick event
  SUMO_OUT:       0x31,   // player fell off platform
  BANANA_DROP:    0x32,   // banana dropped
  BANANA_REMOVE:  0x33,   // banana collected/destroyed

  // Gameplay — events (JSON)
  TRACK_SUBMIT:   0x40,   // draw mode track submission

  // Disconnect
  LEAVE:          0xFE,
};

// ── Message types (server → client) ──────────────────────────────────────
const SERV = {
  // Lobby
  WELCOME:        0x80,   // you're accepted, here's your ID + settings
  ROSTER:         0x81,   // updated player list
  FULL:           0x82,   // room is full
  SETTINGS:       0x83,   // lobby settings broadcast

  // Gameplay — binary
  SNAP:           0xA0,   // authoritative snapshot (all players) (17 bytes/player)
  SNAP_PAINT:     0xA1,   // paint mode snapshot
  SNAP_SUMO:      0xA2,   // sumo mode snapshot
  SNAP_SOCCER:    0xA3,   // soccer mode snapshot (ball + scores)
  START:          0xA4,   // race start with absolute time
  RESET_POS:      0xA5,   // authoritative reset positions (kickoff, respawn)
  ELIM:           0xA6,   // player eliminated (sumo)
  GOAL:           0xA7,   // goal scored (soccer)
  ROUND_END:      0xA8,   // round/match ended
  OIL:            0xA9,   // oil puddle spawn
  PAINT_DELTA:    0xB0,   // paint grid cells changed
  PAINT_COUNTS:   0xB1,   // paint coverage percentages

  // Gameplay — JSON
  SOC_SNAP:       0xC0,   // soccer full snapshot (ball state, clocks, pads)
  GP_RESULT:      0xC1,   // grand prix result
  DRAW_START:     0xC2,   // draw mode start
  TRACK_POOL:     0xC3,   // track pool for roulette
  ROULETTE:       0xC4,   // selected track
  GS_INIT:        0xC5,   // grand slam init
  GS_PICK:        0xC6,   // grand slam pick
  GS_RESULT:      0xC7,   // grand slam result

  // System
  PING:           0xFE,   // keepalive / latency measurement
  PONG:           0xFF,
};

// ── State flags (packed into 1 byte) ────────────────────────────────────
const FLAG = {
  DRIFTING:  0x01,
  BOOSTING:  0x02,
  AIRBORNE:  0x04,
  FINISHED:  0x08,
  SUMO_OUT:  0x10,
  DASH:      0x20,
  CHARGE:    0x40,
};

// ── Binary encoders ──────────────────────────────────────────────────────

function encodeState(msg) {
  // STATE: [type:u8, id:u8, x:i16, y:i16, angle:i16, flags:u8] = 10 bytes
  // Uses i16 for positions (centipixel precision, range ±327.67 px)
  const buf = Buffer.alloc(10);
  buf.writeUInt8(MSG.STATE, 0);
  buf.writeUInt8(msg.id & 0xFF, 1);
  buf.writeInt16BE(Math.round(msg.x * 100) & 0xFFFF, 2);
  buf.writeInt16BE(Math.round(msg.y * 100) & 0xFFFF, 4);
  buf.writeInt16BE(Math.round(((msg.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, 6);
  let flags = 0;
  if (msg.drift) flags |= FLAG.DRIFTING;
  if (msg.boost) flags |= FLAG.BOOSTING;
  if (msg.airborne) flags |= FLAG.AIRBORNE;
  if (msg.finished) flags |= FLAG.FINISHED;
  if (msg.out) flags |= FLAG.SUMO_OUT;
  if (msg.dash) flags |= FLAG.DASH;
  if (msg.charge) flags |= FLAG.CHARGE;
  buf.writeUInt8(flags, 8);
  buf.writeUInt8(msg.lap ? Math.min(msg.lap, 255) : 0, 9);
  return buf;
}

function encodeStatePaint(msg) {
  // STATE_PAINT: [type:u8, id:u8, x:i16, y:i16, angle:i16, drift:u8] = 9 bytes
  const buf = Buffer.alloc(9);
  buf.writeUInt8(MSG.STATE_PAINT, 0);
  buf.writeUInt8(msg.id & 0xFF, 1);
  buf.writeInt16BE(Math.round(msg.x * 100) & 0xFFFF, 2);
  buf.writeInt16BE(Math.round(msg.y * 100) & 0xFFFF, 4);
  buf.writeInt16BE(Math.round(((msg.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, 6);
  buf.writeUInt8(msg.drift ? 1 : 0, 8);
  return buf;
}

function encodeStateSumo(msg) {
  // STATE_SUMO: [type:u8, id:u8, x:i16, y:i16, angle:i16, vx:i16, vy:i16, flags:u8] = 14 bytes
  const buf = Buffer.alloc(14);
  buf.writeUInt8(MSG.STATE_SUMO, 0);
  buf.writeUInt8(msg.id & 0xFF, 1);
  buf.writeInt16BE(Math.round(msg.x * 100) & 0xFFFF, 2);
  buf.writeInt16BE(Math.round(msg.y * 100) & 0xFFFF, 4);
  buf.writeInt16BE(Math.round(((msg.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, 6);
  buf.writeInt16BE(Math.round((msg.vx || 0) * 10) & 0xFFFF, 8);
  buf.writeInt16BE(Math.round((msg.vy || 0) * 10) & 0xFFFF, 10);
  let flags = 0;
  if (msg.dash) flags |= FLAG.DASH;
  if (msg.charge) flags |= FLAG.CHARGE;
  if (msg.out) flags |= FLAG.SUMO_OUT;
  buf.writeUInt8(flags, 12);
  buf.writeUInt8(msg.chargeLevel ? Math.round(msg.chargeLevel * 255) : 0, 13);
  return buf;
}

function encodeStateSoccer(msg) {
  // STATE_SOCCER: [type:u8, id:u8, x:i16, y:i16, angle:i16, flags:u8] = 9 bytes
  const buf = Buffer.alloc(9);
  buf.writeUInt8(MSG.STATE_SOCCER, 0);
  buf.writeUInt8(msg.id & 0xFF, 1);
  buf.writeInt16BE(Math.round(msg.x * 100) & 0xFFFF, 2);
  buf.writeInt16BE(Math.round(msg.y * 100) & 0xFFFF, 4);
  buf.writeInt16BE(Math.round(((msg.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, 6);
  let flags = 0;
  if (msg.boost) flags |= FLAG.BOOSTING;
  buf.writeUInt8(flags, 8);
  return buf;
}

function encodeSnap(players) {
  // SNAP: [type:u8, count:u8, ...per player: id:u8, x:i16, y:i16, angle:i16, vx:i16, vy:i16, flags:u8]
  // = 1 + 1 + (count * 13) bytes
  const count = Math.min(players.length, 8);
  const buf = Buffer.alloc(2 + count * 13);
  buf.writeUInt8(SERV.SNAP, 0);
  buf.writeUInt8(count, 1);
  for (let i = 0; i < count; i++) {
    const p = players[i];
    const off = 2 + i * 13;
    buf.writeUInt8(p.id & 0xFF, off);
    buf.writeInt16BE(Math.round(p.x * 100) & 0xFFFF, off + 1);
    buf.writeInt16BE(Math.round(p.y * 100) & 0xFFFF, off + 3);
    buf.writeInt16BE(Math.round(((p.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, off + 5);
    buf.writeInt16BE(Math.round((p.vx || 0) * 10) & 0xFFFF, off + 7);
    buf.writeInt16BE(Math.round((p.vy || 0) * 10) & 0xFFFF, off + 9);
    let flags = 0;
    if (p.drift) flags |= FLAG.DRIFTING;
    if (p.boost) flags |= FLAG.BOOSTING;
    if (p.airborne) flags |= FLAG.AIRBORNE;
    if (p.finished) flags |= FLAG.FINISHED;
    if (p.out) flags |= FLAG.SUMO_OUT;
    buf.writeUInt8(flags, off + 11);
    buf.writeUInt8(p.lap ? Math.min(p.lap, 255) : 0, off + 12);
  }
  return buf;
}

function encodeResetPositions(positions) {
  // RESET_POS: [type:u8, count:u8, ...per player: id:u8, x:i16, y:i16, angle:i16, vx:i16, vy:i16]
  const count = Math.min(positions.length, 8);
  const buf = Buffer.alloc(2 + count * 11);
  buf.writeUInt8(SERV.RESET_POS, 0);
  buf.writeUInt8(count, 1);
  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const off = 2 + i * 11;
    buf.writeUInt8(p.id & 0xFF, off);
    buf.writeInt16BE(Math.round(p.x * 100) & 0xFFFF, off + 1);
    buf.writeInt16BE(Math.round(p.y * 100) & 0xFFFF, off + 3);
    buf.writeInt16BE(Math.round(((p.angle || 0) % (Math.PI * 2)) * 1000) & 0xFFFF, off + 5);
    buf.writeInt16BE(Math.round((p.vx || 0) * 10) & 0xFFFF, off + 7);
    buf.writeInt16BE(Math.round((p.vy || 0) * 10) & 0xFFFF, off + 9);
  }
  return buf;
}

function encodeStart(startDelayMs, seed, settings) {
  // START: [type:u8, startDelayMs:u32, seed:u32, settingsLen:u8, ...settings bytes]
  // startDelayMs = ms from now until race starts (avoids Date.now() u32 overflow)
  const settingsBuf = Buffer.from(JSON.stringify(settings));
  const buf = Buffer.alloc(11 + settingsBuf.length);
  buf.writeUInt8(SERV.START, 0);
  buf.writeUInt32BE(Math.max(0, Math.min(startDelayMs, 0xFFFFFFFF)) >>> 0, 1);
  buf.writeUInt32BE(seed >>> 0, 5);
  buf.writeUInt8(settingsBuf.length, 9);
  settingsBuf.copy(buf, 10);
  return buf;
}

// ── Binary decoder ───────────────────────────────────────────────────────

function decodeState(buf) {
  return {
    type: MSG.STATE,
    id: buf.readUInt8(1),
    x: buf.readInt16BE(2) / 100,
    y: buf.readInt16BE(4) / 100,
    angle: buf.readInt16BE(6) / 1000,
    flags: buf.readUInt8(8),
    lap: buf.readUInt8(9),
  };
}

function decodeStatePaint(buf) {
  return {
    type: MSG.STATE_PAINT,
    id: buf.readUInt8(1),
    x: buf.readInt16BE(2) / 100,
    y: buf.readInt16BE(4) / 100,
    angle: buf.readInt16BE(6) / 1000,
    drift: buf.readUInt8(8) === 1,
  };
}

function decodeStateSumo(buf) {
  return {
    type: MSG.STATE_SUMO,
    id: buf.readUInt8(1),
    x: buf.readInt16BE(2) / 100,
    y: buf.readInt16BE(4) / 100,
    angle: buf.readInt16BE(6) / 1000,
    vx: buf.readInt16BE(8) / 10,
    vy: buf.readInt16BE(10) / 10,
    flags: buf.readUInt8(12),
    chargeLevel: buf.readUInt8(13) / 255,
  };
}

function decodeStateSoccer(buf) {
  return {
    type: MSG.STATE_SOCCER,
    id: buf.readUInt8(1),
    x: buf.readInt16BE(2) / 100,
    y: buf.readInt16BE(4) / 100,
    angle: buf.readInt16BE(6) / 1000,
    flags: buf.readUInt8(8),
  };
}

function flagsToObj(flags) {
  return {
    drift: !!(flags & FLAG.DRIFTING),
    boost: !!(flags & FLAG.BOOSTING),
    airborne: !!(flags & FLAG.AIRBORNE),
    finished: !!(flags & FLAG.FINISHED),
    out: !!(flags & FLAG.SUMO_OUT),
    dash: !!(flags & FLAG.DASH),
    charge: !!(flags & FLAG.CHARGE),
  };
}

module.exports = {
  MSG, SERV, FLAG,
  encodeState, encodeStatePaint, encodeStateSumo, encodeStateSoccer,
  encodeSnap, encodeResetPositions, encodeStart,
  decodeState, decodeStatePaint, decodeStateSumo, decodeStateSoccer,
  flagsToObj,
};
