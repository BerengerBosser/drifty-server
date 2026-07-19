/* ═══════════════════════════════════════════════════════════════════════════
   room.js — Gestion d'une room Drifty (4 joueurs max)

   Responsabilités :
   - Gestion du roster, lobby, paramètres
   - Sync countdown (autoritaire)
   - Délégation au mode de jeu actif (race, paint, sumo, soccer)
   - Broadcast binaire optimisé des positions
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  MSG, SERV, FLAG,
  encodeState, encodeStatePaint, encodeStateSumo, encodeStateSoccer,
  encodeSnap, encodeResetPositions, encodeStart,
  decodeState, decodeStatePaint, decodeStateSumo, decodeStateSoccer,
  flagsToObj,
} = require('./protocol');

const SLOT_COLORS = ['#12d6c6', '#ff5ad0', '#a8ee3a', '#ff8a3d'];
const CAR_COLORS = ['#ff4d5e', '#ff8a3d', '#ffc531', '#a8ee3a', '#25e08a', '#12d6c6', '#3aa0ff', '#7b5cff', '#ff5ad0', '#eef2ff'];
const MAX_PLAYERS = 4;
const SEND_INTERVAL_MS = 33; // ~30 Hz server tick

// ── Sumo arena constants (must match client) ────────────────────────────
const SUMO_R0 = 320;
const SUMO_RMIN = 140;
const SUMO_CARR = 22;
const SUMO_DASH = 650;
const SUMO_RESTITUTION = 0.7;

// ── Paint grid constants (must match client) ────────────────────────────
const PAINT_GRID_SIZE = 64;
const PAINT_STAMP_R = 30;
const PAINT_STAMP_RD = 24;
const PAINT_STAMP_DRIFT_R = 42;

class Room {
  constructor(code, hostWs, msg) {
    this.code = code;
    this.players = new Map();   // id → { ws, name, slot, color, carStyle, photo, stats, cloudId, isBot, state }
    this.hostId = 'host';
    this.gameMode = 'classic';
    this.lapsTarget = 3;
    this.gpRaces = 1;
    this.collisionsEnabled = true;
    this.bananaMode = 'none';
    this.trackMode = 'classic';
    this.speedClass = 'medium';
    this.paintFormat = 'ffa';
    this.phase = 'lobby';
    this.mapSeed = 0;
    this.startTime = 0;
    this.sendAcc = 0;
    this.emptySince = Date.now();

    // Bot counter
    this._botCounter = 0;

    // Add host
    this.players.set('host', {
      ws: hostWs,
      name: msg.name || 'Hôte',
      slot: 0,
      color: CAR_COLORS[0],
      carStyle: 0,
      photo: msg.photo || null,
      stats: msg.stats || null,
      cloudId: msg.cloudId || null,
      isBot: false,
      isLocal: true,
      state: this._emptyState(),
    });

    // Mode-specific state
    this._mode = null; // will be set on race start
    this._lastTick = 0;
  }

  // ── Player management ───────────────────────────────────────────────
  addPlayer(id, ws, msg) {
    const usedSlots = new Set([...this.players.values()].map(p => p.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot++;
    const color = CAR_COLORS[slot % CAR_COLORS.length];
    this.players.set(id, {
      ws, name: msg.name || 'Joueur', slot, color, carStyle: 0,
      photo: msg.photo || null, stats: msg.stats || null,
      cloudId: msg.cloudId || null, isBot: false, isLocal: false,
      state: this._emptyState(),
    });
    this.emptySince = 0;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  getPlayerSlot(id) {
    const p = this.players.get(id);
    return p ? p.slot : -1;
  }

  _emptyState() {
    return { x: 0, y: 0, angle: 0, vx: 0, vy: 0, drift: false, boost: false,
             airborne: false, finished: false, out: false, lap: 0, prog: 0,
             dash: false, charge: false, chargeLevel: 0, dashUntil: 0 };
  }

  getRoster() {
    const r = [];
    for (const [id, p] of this.players) {
      r.push({ id, name: p.name, slot: p.slot, color: p.color, carStyle: p.carStyle,
               isBot: p.isBot, photo: p.photo, stats: p.stats });
    }
    return r;
  }

  getSettings() {
    return {
      gameMode: this.gameMode, lapsTarget: this.lapsTarget, gpRaces: this.gpRaces,
      collisionsEnabled: this.collisionsEnabled, bananaMode: this.bananaMode,
      trackMode: this.trackMode, speedClass: this.speedClass, paintFormat: this.paintFormat,
    };
  }

  updateSettings(msg) {
    if (msg.gameMode !== undefined) this.gameMode = msg.gameMode;
    if (msg.lapsTarget !== undefined) this.lapsTarget = msg.lapsTarget;
    if (msg.gpRaces !== undefined) this.gpRaces = msg.gpRaces;
    if (msg.collisionsEnabled !== undefined) this.collisionsEnabled = msg.collisionsEnabled;
    if (msg.bananaMode !== undefined) this.bananaMode = msg.bananaMode;
    if (msg.trackMode !== undefined) this.trackMode = msg.trackMode;
    if (msg.speedClass !== undefined) this.speedClass = msg.speedClass;
    if (msg.paintFormat !== undefined) this.paintFormat = msg.paintFormat;
  }

  updatePlayerCosmetic(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (msg.color !== undefined) p.color = msg.color;
    if (msg.carStyle !== undefined) p.carStyle = msg.carStyle;
  }

  // ── Bots ────────────────────────────────────────────────────────────
  addBot() {
    if (this.players.size >= MAX_PLAYERS) return;
    const usedSlots = new Set([...this.players.values()].map(p => p.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot++;
    this._botCounter++;
    const id = 'mbot_' + this._botCounter;
    const color = CAR_COLORS[slot % CAR_COLORS.length];
    this.players.set(id, {
      ws: null, name: 'Bot ' + this._botCounter, slot, color, carStyle: 0,
      photo: null, stats: null, cloudId: null, isBot: true, isLocal: false,
      state: this._emptyState(),
    });
  }

  removeBot() {
    const bot = [...this.players.values()].reverse().find(p => p.isBot);
    if (!bot) return;
    for (const [id, p] of this.players) {
      if (p === bot) { this.players.delete(id); break; }
    }
  }

  // ── Race start ──────────────────────────────────────────────────────
  startRace(msg) {
    this.phase = 'countdown';
    this.mapSeed = msg.seed || Math.floor(Math.random() * 999999);
    // Absolute start time: now + 2.5 seconds (accounts for network latency)
    this.startTime = Date.now() + 2500;

    // Initialize mode
    const mode = this.gameMode;
    if (mode === 'paint' || mode === 'territoire') {
      this._mode = new PaintMode(this);
    } else if (mode === 'sumo') {
      this._mode = new SumoMode(this);
    } else if (mode === 'foot' || mode === 'soccer') {
      this._mode = new SoccerMode(this);
    } else {
      this._mode = new RaceMode(this);
    }
    this._mode.init();

    // Reset player states
    for (const [, p] of this.players) {
      p.state = this._emptyState();
    }

    // Broadcast start with absolute time
    const settings = {
      bananaMode: this.bananaMode, collisionsEnabled: this.collisionsEnabled,
      gpTotal: this.gpRaces, gpCurrent: 0, paintFormat: this.paintFormat,
      speedClass: this.speedClass,
    };
    const buf = encodeStart(this.startTime, this.mapSeed, settings);
    for (const [, p] of this.players) {
      if (p.ws) try { p.ws.send(buf); } catch (e) {}
    }

    // Auto-start game phase after countdown
    setTimeout(() => {
      if (this.phase === 'countdown') {
        this.phase = 'racing';
      }
    }, 2500);
  }

  resetToLobby() {
    this.phase = 'lobby';
    this._mode = null;
    this.broadcast({ type: 'reset' });
  }

  broadcast(data) {
    const str = JSON.stringify(data);
    for (const [, p] of this.players) {
      if (p.ws && p.ws.readyState === 1) {
        try { p.ws.send(str); } catch (e) {}
      }
    }
  }

  broadcastBinary(buf) {
    for (const [, p] of this.players) {
      if (p.ws && p.ws.readyState === 1) {
        try { p.ws.send(buf); } catch (e) {}
      }
    }
  }

  sendTo(playerId, data) {
    const p = this.players.get(playerId);
    if (p && p.ws && p.ws.readyState === 1) {
      try { p.ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) {}
    }
  }

  // ── State updates from players ──────────────────────────────────────
  onPlayerState(playerId, buf) {
    const p = this.players.get(playerId);
    if (!p) return;

    const type = buf[0];
    let decoded;

    if (type === MSG.STATE) {
      decoded = decodeState(buf);
      const flags = flagsToObj(decoded.flags);
      p.state.x = decoded.x;
      p.state.y = decoded.y;
      p.state.angle = decoded.angle;
      p.state.drift = flags.drift;
      p.state.boost = flags.boost;
      p.state.airborne = flags.airborne;
      p.state.finished = flags.finished;
      p.state.out = flags.out;
      p.state.dash = flags.dash;
      p.state.charge = flags.charge;
      if (decoded.lap) p.state.lap = decoded.lap;
    } else if (type === MSG.STATE_PAINT) {
      decoded = decodeStatePaint(buf);
      p.state.x = decoded.x;
      p.state.y = decoded.y;
      p.state.angle = decoded.angle;
      p.state.drift = decoded.drift;
    } else if (type === MSG.STATE_SUMO) {
      decoded = decodeStateSumo(buf);
      p.state.x = decoded.x;
      p.state.y = decoded.y;
      p.state.angle = decoded.angle;
      p.state.vx = decoded.vx;
      p.state.vy = decoded.vy;
      p.state.dash = decoded.flags & FLAG.DASH ? true : false;
      p.state.charge = decoded.flags & FLAG.CHARGE ? true : false;
      p.state.out = decoded.flags & FLAG.SUMO_OUT ? true : false;
      p.state.chargeLevel = decoded.chargeLevel;
    } else if (type === MSG.STATE_SOCCER) {
      decoded = decodeStateSoccer(buf);
      p.state.x = decoded.x;
      p.state.y = decoded.y;
      p.state.angle = decoded.angle;
      p.state.boost = flagsToObj(decoded.flags).boost;
    }
  }

  // JSON state update (client sends JSON, not binary)
  onPlayerStateJSON(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (msg.x !== undefined) p.state.x = msg.x;
    if (msg.y !== undefined) p.state.y = msg.y;
    if (msg.angle !== undefined) p.state.angle = msg.angle;
    if (msg.drift !== undefined) p.state.drift = msg.drift;
    if (msg.boost !== undefined) p.state.boost = msg.boost;
    if (msg.airborne !== undefined) p.state.airborne = msg.airborne;
    if (msg.finished !== undefined) p.state.finished = msg.finished;
    if (msg.out !== undefined) p.state.out = msg.out;
    if (msg.dash !== undefined) p.state.dash = msg.dash;
    if (msg.charge !== undefined) p.state.charge = msg.charge;
    if (msg.chargeLevel !== undefined) p.state.chargeLevel = msg.chargeLevel;
    if (msg.lap !== undefined) p.state.lap = msg.lap;
    if (msg.prog !== undefined) p.state.prog = msg.prog;
    if (msg.vx !== undefined) p.state.vx = msg.vx;
    if (msg.vy !== undefined) p.state.vy = msg.vy;
  }

  // ── Game events ─────────────────────────────────────────────────────
  onSoccerHit(playerId) {
    if (this._mode && this._mode.onHit) {
      this._mode.onHit(playerId);
    }
  }

  onSumoOut(playerId) {
    if (this._mode && this._mode.onPlayerOut) {
      this._mode.onPlayerOut(playerId);
    }
  }

  // ── Main tick ───────────────────────────────────────────────────────
  tick(now) {
    if (this.phase === 'lobby') return;

    // Mode-specific tick (collision, authority logic)
    if (this._mode) {
      this._mode.tick(now);
    }

    // Broadcast authoritative snapshot
    this.sendAcc += (now - (this._lastTick || now));
    this._lastTick = now;
    if (this.sendAcc < SEND_INTERVAL_MS) return;
    this.sendAcc = 0;

    this._broadcastSnapshot();
  }

  _broadcastSnapshot() {
    const players = [];
    for (const [id, p] of this.players) {
      players.push({
        id: this._hashId(id),
        x: p.state.x, y: p.state.y, angle: p.state.angle,
        vx: p.state.vx || 0, vy: p.state.vy || 0,
        drift: p.state.drift, boost: p.state.boost,
        airborne: p.state.airborne, finished: p.state.finished,
        out: p.state.out, lap: p.state.lap,
      });
    }
    // For now, use JSON snap (binary snap needs ID mapping)
    this.broadcast({
      type: 'snap',
      players: players.map(p => ({
        id: p.id, x: +p.x.toFixed(1), y: +p.y.toFixed(1),
        angle: +p.angle.toFixed(3), vx: +(p.vx || 0).toFixed(1), vy: +(p.vy || 0).toFixed(1),
        drift: p.drift, boost: p.boost, airborne: p.airborne,
        finished: p.finished, out: p.out, lap: p.lap,
      })),
    });
  }

  // Map string IDs to small numbers for binary protocol
  _hashId(id) {
    if (!this._idMap) this._idMap = new Map();
    if (this._idMap.has(id)) return this._idMap.get(id);
    const next = this._idMap.size;
    this._idMap.set(id, next);
    return next;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode: Race (classic, GP, banana)
// ═══════════════════════════════════════════════════════════════════════════
class RaceMode {
  constructor(room) { this.room = room; }
  init() {}
  tick() {} // Positions are relayed as-is; server validates bounds only
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode: Paint (Territory) — Server is authority for grid + coverage
// ═══════════════════════════════════════════════════════════════════════════
class PaintMode {
  constructor(room) {
    this.room = room;
    this.grid = new Int8Array(PAINT_GRID_SIZE * PAINT_GRID_SIZE); // 0 = unclaimed, owner index otherwise
    this.counts = new Float32Array(8); // per-owner cell counts
    this.totalCells = PAINT_GRID_SIZE * PAINT_GRID_SIZE;
    this.lastBroadcast = 0;
    this.lastCounts = null;
  }

  init() {
    this.room.phase = 'countdown';
    setTimeout(() => { this.room.phase = 'racing'; }, 2500);
  }

  tick(now) {
    if (this.room.phase !== 'racing') return;

    // Stamp paint for all players based on authoritative positions
    for (const [, p] of this.room.players) {
      this._stamp(p);
    }

    // Broadcast paint counts every second
    if (now - this.lastBroadcast > 1000) {
      this.lastBroadcast = now;
      this._computeCounts();
      this.room.broadcast({
        type: 'paintCounts',
        counts: Array.from(this.counts).slice(0, this.room.players.size),
        total: this.totalCells,
      });
    }
  }

  _stamp(player) {
    const s = player.state;
    if (!s.x && !s.y) return;
    const ownerIdx = player.slot;
    const driftR = s.drift ? PAINT_STAMP_DRIFT_R : PAINT_STAMP_R;
    const rx = s.x - Math.cos(s.angle) * PAINT_STAMP_RD;
    const ry = s.y - Math.sin(s.angle) * PAINT_STAMP_RD;

    // Stamp circle
    const gridScale = 8; // pixels per grid cell
    const cx = Math.floor(rx / gridScale) + PAINT_GRID_SIZE / 2;
    const cy = Math.floor(ry / gridScale) + PAINT_GRID_SIZE / 2;
    const r = Math.ceil(driftR / gridScale);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= PAINT_GRID_SIZE || gy < 0 || gy >= PAINT_GRID_SIZE) continue;
        const idx = gy * PAINT_GRID_SIZE + gx;
        this.grid[idx] = ownerIdx + 1; // 1-indexed
      }
    }
  }

  _computeCounts() {
    this.counts.fill(0);
    for (let i = 0; i < this.grid.length; i++) {
      const v = this.grid[i];
      if (v > 0 && v < this.counts.length) this.counts[v - 1]++;
    }
  }

  getCoverage() {
    this._computeCounts();
    return { counts: Array.from(this.counts), total: this.totalCells };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode: Sumo — Server is authority for collisions + eliminations
// ═══════════════════════════════════════════════════════════════════════════
class SumoMode {
  constructor(room) {
    this.room = room;
    this.R = SUMO_R0;
    this.Rmin = SUMO_RMIN;
    this.R0 = SUMO_R0;
    this.roundStartAt = 0;
    this.round = 1;
    this.maxRounds = 3;
    this.scores = {};
    this.roundOver = false;
    this.oils = [];
    this.nextOil = 0;
    this.eliminated = new Set();
  }

  init() {
    this.R = this.R0;
    this.roundStartAt = Date.now() + 2500; // after countdown
    this.roundOver = false;
    this.eliminated.clear();
    this.oils = [];
    this.nextOil = Date.now() + 5500;
    for (const [, p] of this.room.players) {
      this.scores[p.name] = 0;
    }
  }

  tick(now) {
    if (this.room.phase !== 'racing') return;

    // Shrink arena
    const elapsed = (now - this.roundStartAt) / 1000;
    this.R = Math.max(this.Rmin, this.R0 - (this.R0 - this.Rmin) * clamp((elapsed - 4) / 26, 0, 1));

    // Server-authoritative collisions between all non-eliminated players
    const alive = [];
    for (const [id, p] of this.room.players) {
      if (!p.state.out && !this.eliminated.has(id)) {
        alive.push({ id, state: p.state });
      }
    }

    this._collide(now, alive);

    // Check elimination (outside arena)
    for (const a of alive) {
      const dist = Math.hypot(a.state.x, a.state.y);
      if (dist > this.R) {
        this._eliminate(a.id, now);
      }
    }

    // Oil spawning (host-like authority)
    if (now >= this.nextOil) {
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * this.R * 0.92;
      const oil = {
        x: Math.cos(ang) * rr, y: Math.sin(ang) * rr,
        r: 58 + Math.random() * 26, until: now + 8000,
      };
      this.oils.push(oil);
      this.nextOil = now + 4500 + Math.random() * 3000;
      this.room.broadcast({ type: 'sumoOil', ...oil });
    }
    this.oils = this.oils.filter(o => o.until > now);

    // Check round end
    const stillAlive = alive.filter(a => !this.eliminated.has(a.id));
    if (stillAlive.length <= 1 && !this.roundOver) {
      this._endRound(stillAlive[0] ? stillAlive[0].id : null, now);
    }
  }

  _collide(now, alive) {
    const R2 = SUMO_CARR * 2;
    // Store velocities before collision
    const vel = new Map();
    for (const a of alive) {
      vel.set(a.id, [a.state.vx || 0, a.state.vy || 0]);
    }

    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      const av = vel.get(a.id);
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const bv = vel.get(b.id);
        const dx = a.state.x - b.state.x;
        const dy = a.state.y - b.state.y;
        const d = Math.hypot(dx, dy);
        if (d >= R2 || d < 0.1) continue;

        const nx = dx / d, ny = dy / d;
        const overlap = R2 - d;

        // Symmetric separation
        a.state.x += nx * overlap * 0.5;
        a.state.y += ny * overlap * 0.5;
        b.state.x -= nx * overlap * 0.5;
        b.state.y -= ny * overlap * 0.5;

        // Elastic impulse
        const rvn = (av[0] - bv[0]) * nx + (av[1] - bv[1]) * ny;
        if (rvn < 0) {
          const imp = -(1 + SUMO_RESTITUTION) * rvn * 0.5;
          const dashBonusA = a.state.dash ? 450 : 0;
          const dashBonusB = b.state.dash ? 450 : 0;
          a.state.vx += (imp + dashBonusA) * nx;
          a.state.vy += (imp + dashBonusA) * ny;
          b.state.vx -= (imp + dashBonusB) * nx;
          b.state.vy -= (imp + dashBonusB) * ny;
        }
      }
    }
  }

  _eliminate(playerId, now) {
    if (this.eliminated.has(playerId)) return;
    this.eliminated.add(playerId);
    const p = this.room.players.get(playerId);
    if (p) { p.state.out = true; p.state.vx = 0; p.state.vy = 0; }
    this.room.broadcast({ type: 'sumoElim', id: this.room._hashId(playerId) });
  }

  onPlayerOut(playerId) {
    // Client reported falling — validate and eliminate
    this._eliminate(playerId, Date.now());
  }

  _endRound(winnerId, now) {
    this.roundOver = true;
    if (winnerId) {
      const winner = this.room.players.get(winnerId);
      if (winner) this.scores[winner.name] = (this.scores[winner.name] || 0) + 1;
    }
    const final = this.round >= this.maxRounds;
    this.room.broadcast({
      type: 'sumoRound', winnerKey: winnerId,
      scores: this.scores, round: this.round, final,
    });

    setTimeout(() => {
      if (final) {
        this.room.phase = 'finished';
        this.room.broadcast({ type: 'sumoFinal', scores: this.scores });
      } else {
        this.round++;
        this.roundStartAt = Date.now() + 3200;
        this.roundOver = false;
        this.eliminated.clear();
        this.oils = [];
        this.nextOil = Date.now() + 5500;
        // Reset player positions
        for (const [, p] of this.room.players) {
          p.state.x = 0; p.state.y = 0; p.state.vx = 0; p.state.vy = 0;
          p.state.out = false;
        }
        this.room.broadcast({ type: 'sumoNext', round: this.round });
      }
    }, 2600);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode: Soccer (Foot Arena) — Server is authority for ball, goals, kickoff
// ═══════════════════════════════════════════════════════════════════════════
class SoccerMode {
  constructor(room) {
    this.room = room;
    // Field dimensions (must match client)
    this.F = { HW: 260, HH: 160, CR: 40, carR: 18 };
    this.ball = { x: 0, y: 0, vx: 0, vy: 0 };
    this.score = [0, 0];
    this.clockMs = 90000; // 90 seconds
    this.golden = false;
    this.phase = 'play'; // 'play', 'freeze', 'done'
    this.freezeUntil = 0;
    this.bannerMsg = '';
    this.bannerUntil = 0;
    this.winner = -1;
    this.lastBroadcast = 0;
    this.hits = new Map(); // playerId -> hit cooldown end
    this.HIT_COOLDOWN = 400;
    this.HIT_POWER = 520;
    this.BALL_FR = 0.985;
    this.GOALS_TO_WIN = 3;
    this.confetti = [];

    // Team assignment
    this.teams = [[], []]; // team 0, team 1
  }

  init() {
    // Assign teams: slots 0,2 → team 0; slots 1,3 → team 1
    const players = [...this.room.players.values()].sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < players.length; i++) {
      const team = i % 2;
      this.teams[team].push(players[i]);
      players[i]._socTeam = team;
    }
    this.ball = { x: 0, y: 0, vx: 0, vy: 0 };
    this.score = [0, 0];
    this.clockMs = 90000;
    this.golden = false;
    this.phase = 'play';
    this.winner = -1;
    this._kickoff();

    setTimeout(() => { this.room.phase = 'racing'; }, 2500);
  }

  _kickoff() {
    this.ball = { x: 0, y: 0, vx: 0, vy: 0 };
    this.freezeUntil = Date.now() + 1500;
    this.bannerMsg = ''; this.bannerUntil = 0;

    const positions = [];
    for (let ti = 0; ti < 2; ti++) {
      const ps = this.teams[ti];
      const side = ti === 0 ? -1 : 1;
      for (let j = 0; j < ps.length; j++) {
        const x = side * this.F.HW * 0.42;
        const y = (ps.length === 1 ? 0 : (j - (ps.length - 1) / 2) * this.F.HH * 0.45);
        const angle = ti === 0 ? 0 : Math.PI;
        const p = this.room.players.get(ps[j].name ? [...this.room.players.entries()].find(([k, v]) => v === ps[j])?.[0] : null);
        if (p) {
          p.state.x = x; p.state.y = y; p.state.angle = angle;
          p.state.vx = 0; p.state.vy = 0;
        }
        // Find the actual player ID for this team member
        for (const [id, pp] of this.room.players) {
          if (pp === ps[j]) {
            positions.push({ id, x, y, angle, vx: 0, vy: 0 });
            break;
          }
        }
      }
    }
    this.room.broadcast({
      type: 'socReset',
      ball: { x: 0, y: 0, vx: 0, vy: 0 },
      positions,
      freezeUntil: this.freezeUntil,
    });
  }

  onHit(playerId) {
    // Check cooldown
    const now = Date.now();
    if (this.hits.has(playerId) && now < this.hits.get(playerId)) return;
    this.hits.set(playerId, now + this.HIT_COOLDOWN);

    // Find the player's state and check proximity to ball
    const p = this.room.players.get(playerId);
    if (!p) return;
    const dist = Math.hypot(p.state.x - this.ball.x, p.state.y - this.ball.y);
    if (dist > this.F.carR + 20) return; // too far

    // Apply impulse to ball
    const angle = p.state.angle || 0;
    this.ball.vx += Math.cos(angle) * this.HIT_POWER;
    this.ball.vy += Math.sin(angle) * this.HIT_POWER;
  }

  tick(now) {
    if (this.room.phase !== 'racing') return;

    const dt = 1 / 30; // server tick rate
    const frozen = now < this.freezeUntil;

    if (this.phase === 'done') return;

    // Ball physics (when not frozen)
    if (!frozen && this.phase === 'play') {
      this.ball.x += this.ball.vx * dt;
      this.ball.y += this.ball.vy * dt;
      this.ball.vx *= this.BALL_FR;
      this.ball.vy *= this.BALL_FR;

      // Wall reflection
      const hw = this.F.HW, hh = this.F.HH;
      if (this.ball.x > hw + 10) { this._goal(0, now); return; }
      if (this.ball.x < -hw - 10) { this._goal(1, now); return; }
      if (this.ball.y > hh) { this.ball.y = hh; this.ball.vy *= -0.6; }
      if (this.ball.y < -hh) { this.ball.y = -hh; this.ball.vy *= -0.6; }

      // Check car-ball collisions (server authoritative)
      for (const [, p] of this.room.players) {
        const dx = p.state.x - this.ball.x;
        const dy = p.state.y - this.ball.y;
        const dist = Math.hypot(dx, dy);
        const minDist = this.F.carR + 12;
        if (dist < minDist && dist > 0.1) {
          // Push ball away from car
          const nx = dx / dist, ny = dy / dist;
          this.ball.x = p.state.x - nx * minDist;
          this.ball.y = p.state.y - ny * minDist;
          const vn = this.ball.vx * nx + this.ball.vy * ny;
          if (vn < 0) {
            this.ball.vx -= 1.5 * vn * nx;
            this.ball.vy -= 1.5 * vn * ny;
          }
        }
      }
    }

    // Timer
    if (this.phase === 'play' && !this.golden) {
      this.clockMs -= dt * 1000;
      if (this.clockMs <= 0) {
        this.clockMs = 0;
        if (this.score[0] === this.score[1]) {
          this.golden = true;
          this.bannerMsg = 'BUT EN OR';
          this.bannerUntil = now + 2600;
          this.freezeUntil = Math.max(this.freezeUntil, now + 1400);
        } else {
          this._finish(this.score[0] > this.score[1] ? 0 : 1, now);
        }
      }
    }
  }

  _goal(scorer, now) {
    this.score[scorer]++;
    const cap = this.golden ? Infinity : this.GOALS_TO_WIN;
    if (this.score[scorer] >= cap) {
      this._finish(scorer, now);
      return;
    }
    this.bannerMsg = 'BUT!';
    this.bannerUntil = now + 1700;
    this.room.broadcast({
      type: 'socGoal', team: scorer,
      score: [...this.score],
    });
    this._kickoff();
  }

  _finish(winner, now) {
    this.winner = winner;
    this.phase = 'done';
    this.bannerMsg = 'FIN';
    this.bannerUntil = now + 3200;
    this.room.broadcast({
      type: 'socEnd', winner,
      score: [...this.score],
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────
function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

module.exports = Room;
