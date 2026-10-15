// ---------------------------------------------------------------------------
// match.js — the AUTHORITATIVE game. One Match = one game server.
//
// Online it runs inside a Cloudflare Durable Object; in Practice mode the
// exact same code runs in your browser. It owns the truth: positions, hits,
// health, money, rounds. Clients only send inputs (usercmds).
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE, PLAYER, HULL_STAND, HULL_DUCK } from './constants.js';
import { createPlayerState, playerMove, spectatorMove, getHull } from './movement.js';
import { createTrace } from './collision.js';
import { createEntityState, EFLAG } from './protocol.js';
import { IN } from './usercmd.js';

export const TEAM = { NONE: 0, T: 1, CT: 2, SPEC: 3 };
export const TEAM_NAME = { 0: 'NONE', 1: 'T', 2: 'CT', 3: 'SPEC' };

const MAX_PLAYERS = 20;
const MAX_QUEUED_CMDS = 32; // drop anything beyond this (flooding)
const CMD_BURST = 8; // extra ticks of input a lagging client may catch up

export class Match {
  /**
   * @param opts.world     CollisionWorld built from the map
   * @param opts.map       MAP config (spawns, bombsites, ...)
   * @param opts.mode      'practice' | 'defusal'
   */
  constructor(opts) {
    this.world = opts.world;
    this.map = opts.map;
    this.mode = opts.mode || 'defusal';
    this.tick = 0;
    this.players = new Map(); // id -> player
    this.events = []; // gameplay events this tick (sent as JSON)
    this.log = opts.log || (() => {});
    this.spawnCursor = { 1: 0, 2: 0 };
    this._tr = createTrace();
  }

  get time() { return this.tick * TICK_DT; }

  // ---- players -------------------------------------------------------------------
  nextId() {
    for (let id = 1; id < 256; id++) if (!this.players.has(id)) return id;
    return -1;
  }

  addPlayer({ name, team, token }) {
    if (this.players.size >= MAX_PLAYERS) return null;
    const id = this.nextId();
    if (id < 0) return null;
    const p = {
      id,
      name: sanitizeName(name),
      token,
      team: TEAM.SPEC,
      connected: true,
      ps: createPlayerState(),
      alive: false,
      health: 0,
      armor: 0,
      helmet: false,
      money: 800,
      cmdQueue: [],
      lastCmdNum: 0,
      lastButtons: 0,
      yaw: 0,
      pitch: 0,
      cmdTokens: CMD_BURST,
      stats: { kills: 0, deaths: 0, assists: 0, damage: 0, score: 0, mvps: 0 },
      netCache: new Map(),
      respawnAt: 0,
    };
    this.players.set(id, p);
    this.setTeam(p, team || this.autoTeam());
    this.emit({ type: 'join', id, name: p.name, team: p.team });
    return p;
  }

  autoTeam() {
    let t = 0, ct = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAM.T) t++;
      else if (p.team === TEAM.CT) ct++;
    }
    return t <= ct ? TEAM.T : TEAM.CT;
  }

  setTeam(p, team) {
    if (team !== TEAM.T && team !== TEAM.CT && team !== TEAM.SPEC) return;
    p.team = team;
    p.alive = false;
    if (team !== TEAM.SPEC) this.spawnPlayer(p);
    this.emit({ type: 'team', id: p.id, team });
  }

  removePlayer(p) {
    this.players.delete(p.id);
    for (const other of this.players.values()) other.netCache.delete(p.id);
    this.emit({ type: 'leave', id: p.id });
  }

  disconnect(p) {
    p.connected = false;
    p.cmdQueue.length = 0;
    if (p.alive) this.killPlayer(p, null, 'disconnect');
    this.emit({ type: 'disconnect', id: p.id });
  }

  reconnect(p) {
    p.connected = true;
    p.cmdQueue.length = 0;
    p.netCache.clear();
    p.cmdTokens = CMD_BURST;
    this.emit({ type: 'reconnect', id: p.id });
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ---- spawning ------------------------------------------------------------------
  spawnPlayer(p) {
    const list = this.mode === 'practice' && p.team === TEAM.T && !this.map.spawns.T
      ? [this.map.devSpawn]
      : (p.team === TEAM.CT ? this.map.spawns.CT : this.map.spawns.T);
    const spot = this.findFreeSpawn(list, p);
    const ps = createPlayerState();
    ps.pos[0] = spot[0]; ps.pos[1] = spot[1]; ps.pos[2] = spot[2];
    this.dropToFloor(ps);
    p.ps = ps;
    p.yaw = spot[3] || 0;
    p.pitch = 0;
    p.alive = true;
    p.health = 100;
    this.emit({ type: 'spawn', id: p.id, pos: ps.pos.slice(), yaw: p.yaw });
  }

  findFreeSpawn(list, p) {
    const team = p.team;
    for (let i = 0; i < list.length; i++) {
      const idx = (this.spawnCursor[team] + i) % list.length;
      const s = list[idx];
      let free = true;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        if (Math.abs(o.ps.pos[0] - s[0]) < 33 && Math.abs(o.ps.pos[1] - s[1]) < 33) { free = false; break; }
      }
      if (free) { this.spawnCursor[team] = idx + 1; return s; }
    }
    return list[this.spawnCursor[team]++ % list.length];
  }

  /** Put a freshly spawned player exactly onto the floor below them. */
  dropToFloor(ps) {
    const start = [ps.pos[0], ps.pos[1], ps.pos[2] + 2];
    const end = [ps.pos[0], ps.pos[1], ps.pos[2] - 256];
    this.world.traceBox(start, end, HULL_STAND.mins, HULL_STAND.maxs, this._tr);
    if (this._tr.hit && !this._tr.startsolid) {
      ps.pos[2] = this._tr.endpos[2];
      ps.onGround = this._tr.normal[2] >= 0.7;
    }
  }

  killPlayer(p, attacker, weapon) {
    if (!p.alive) return;
    p.alive = false;
    p.health = 0;
    p.stats.deaths++;
    if (attacker && attacker !== p) attacker.stats.kills++;
    p.respawnAt = this.tick + (this.mode === 'practice' ? TICK_RATE * 2 : Infinity);
    this.emit({ type: 'kill', victim: p.id, attacker: attacker ? attacker.id : 0, weapon: weapon || '' });
  }

  damagePlayer(p, amount, attacker, weapon) {
    if (!p.alive || amount <= 0) return;
    p.health -= amount;
    this.emit({ type: 'damage', id: p.id, amount: Math.round(amount), attacker: attacker ? attacker.id : 0, to: p.id });
    if (p.health <= 0) this.killPlayer(p, attacker, weapon);
  }

  // ---- input ---------------------------------------------------------------------
  queueCmds(p, cmds) {
    for (const c of cmds) {
      if (c.num <= p.lastCmdNum) continue; // duplicate / old
      const last = p.cmdQueue.length ? p.cmdQueue[p.cmdQueue.length - 1].num : p.lastCmdNum;
      if (c.num <= last) continue;
      p.cmdQueue.push(c);
    }
    if (p.cmdQueue.length > MAX_QUEUED_CMDS) p.cmdQueue.splice(0, p.cmdQueue.length - MAX_QUEUED_CMDS);
  }

  /** Other players as solid boxes (CS players can't walk through each other). */
  playerBoxes(except) {
    const boxes = [];
    for (const o of this.players.values()) {
      if (o === except || !o.alive) continue;
      const h = getHull(o.ps);
      boxes.push({
        id: o.id,
        min: [o.ps.pos[0] + h.mins[0], o.ps.pos[1] + h.mins[1], o.ps.pos[2] + h.mins[2]],
        max: [o.ps.pos[0] + h.maxs[0], o.ps.pos[1] + h.maxs[1], o.ps.pos[2] + h.maxs[2]],
      });
    }
    return boxes;
  }

  maxSpeedFor(p) {
    void p;
    return PLAYER.DEFAULT_MAX_SPEED;
  }

  isFrozen(p) {
    void p;
    return false;
  }

  /** Run one usercmd for a player — identical to what the client predicts. */
  runCommand(p, cmd) {
    p.lastCmdNum = cmd.num;
    if (!Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.pitch)) return;
    cmd.pitch = Math.max(-89, Math.min(89, cmd.pitch));
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    p.lastButtons = cmd.buttons;
    if (!p.alive) {
      spectatorMove(p.ps, cmd); // dead players fly around as a free camera
      return;
    }
    const ctx = {
      world: this.world,
      dt: TICK_DT,
      maxSpeed: this.maxSpeedFor(p),
      frozen: this.isFrozen(p),
      boxes: this.playerBoxes(p),
    };
    const ev = playerMove(p.ps, cmd, ctx);
    if (ev.footstep) this.emit({ type: 'step', id: p.id, pos: p.ps.pos.slice(), except: p.id });
    if (ev.landSpeed > PLAYER.FALL_PUNCH_THRESHOLD) this.emit({ type: 'land', id: p.id, speed: Math.round(ev.landSpeed), pos: p.ps.pos.slice(), except: p.id });
    if (ev.fallDamage > 0) this.damagePlayer(p, ev.fallDamage, null, 'fall');
    if (p.ps.pos[2] < this.world.bounds.min[2] - 2000) this.killPlayer(p, null, 'world');
  }

  // ---- the 64-tick loop ----------------------------------------------------------------
  step() {
    this.tick++;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      p.cmdTokens = Math.min(CMD_BURST, p.cmdTokens + 1);
      // Normally run 1 command per tick; catch up if the client's queue grew.
      let n = p.cmdQueue.length > 4 ? p.cmdQueue.length - 2 : Math.min(1, p.cmdQueue.length);
      while (n-- > 0 && p.cmdTokens >= 1) {
        p.cmdTokens -= 1;
        this.runCommand(p, p.cmdQueue.shift());
      }
      // Anti speed-hack: commands beyond the budget are thrown away.
      if (p.cmdQueue.length > CMD_BURST * 2) p.cmdQueue.splice(0, p.cmdQueue.length - CMD_BURST);
    }
    for (const p of this.players.values()) {
      if (!p.alive && p.team !== TEAM.SPEC && this.tick >= p.respawnAt && p.connected) this.spawnPlayer(p);
    }
  }

  emit(ev) {
    this.events.push(ev);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---- network view ----------------------------------------------------------------------
  entityState(p) {
    const e = createEntityState();
    e.id = p.id;
    e.pos = p.ps.pos.slice();
    e.yaw = p.yaw;
    e.pitch = p.pitch;
    e.duck = p.ps.duckAmount;
    e.flags = (p.alive ? EFLAG.ALIVE : 0) | (p.ps.onGround ? EFLAG.ON_GROUND : 0) | (p.ps.ducked ? EFLAG.DUCKED : 0) |
      ((p.lastButtons & IN.WALK) ? EFLAG.WALKING : 0);
    e.weapon = 0;
    e.wflags = 0;
    e.health = p.alive ? p.health : 0;
    e.armor = p.armor;
    e.vel = p.ps.vel.slice();
    e.team = p.team;
    return e;
  }

  publicInfo() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, connected: p.connected, alive: p.alive, stats: p.stats,
    }));
  }
}

export function sanitizeName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 20);
  return s || 'Player';
}

export { HULL_DUCK };
