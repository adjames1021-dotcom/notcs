// ---------------------------------------------------------------------------
// match.js — the AUTHORITATIVE game. One Match = one game server.
//
// Online it runs inside a Cloudflare Durable Object; in Practice mode the
// exact same code runs in your browser. It owns the truth: positions, hits,
// health, money, rounds. Clients only send inputs (usercmds).
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE, PLAYER, HULL_STAND } from './constants.js';
import { createPlayerState, playerMove, spectatorMove, getHull } from './movement.js';
import { createTrace } from './collision.js';
import { createEntityState, EFLAG, writeSchema } from './protocol.js';
import { IN, createCmd } from './usercmd.js';
import {
  createWeaponState, defaultLoadout, processWeapon, weaponMaxSpeed, activeWeapon, applyHitEffects,
  WEAPON_SCHEMA, FLAG, SLOT, eyePos, giveWeapon,
} from './weaponLogic.js';
import { WEAPONS, HITGROUP } from './weapons.js';
import { traceBullet, computeDamage } from './bullets.js';
import { rayPlayer } from './hitboxes.js';
import { GrenadeSystem } from './grenades.js';
import { ItemSystem } from './items.js';
import { ECONOMY, addMoney, killReward, tryBuy, inBox } from './economy.js';

export const TEAM = { NONE: 0, T: 1, CT: 2, SPEC: 3 };
export const TEAM_NAME = { 0: 'NONE', 1: 'T', 2: 'CT', 3: 'SPEC' };

const MAX_PLAYERS = 20;
const MAX_QUEUED_CMDS = 128; // drop anything beyond this (flooding)
const CMD_BURST = 32; // ticks of input a lagging client may catch up at once (anti speed-hack budget)
const LAG_COMP_TICKS = TICK_RATE; // keep ~1 s of hitbox history
const MAX_UNLAG_TICKS = TICK_RATE; // never rewind more than this (anti-cheat)

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
    this.history = []; // lag compensation: [{ tick, states: Map(id -> {pos,yaw,duck,alive}) }]
    this._tr = createTrace();
    this._caps = [];
    this.systems = []; // add-ons (grenades, items, round rules) with optional hooks
    this.grenades = this.addSystem(new GrenadeSystem());
    this.items = this.addSystem(new ItemSystem());
    if (this.mode === 'practice') this.setupPractice();
  }

  get time() { return this.tick * TICK_DT; }

  addSystem(sys) {
    this.systems.push(sys);
    if (sys.attach) sys.attach(this);
    return sys;
  }

  hook(name, ...args) {
    let result;
    for (const s of this.systems) if (s[name]) { const r = s[name](...args); if (r !== undefined) result = r; }
    return result;
  }

  // ---- players -------------------------------------------------------------------
  nextId() {
    for (let id = 1; id < 256; id++) if (!this.players.has(id)) return id;
    return -1;
  }

  createPlayer(id, name) {
    return {
      id,
      name: sanitizeName(name),
      token: null,
      team: TEAM.SPEC,
      connected: true,
      dummy: null,
      ps: createPlayerState(),
      ws: createWeaponState(),
      alive: false,
      health: 0,
      armor: 0,
      helmet: false,
      defuser: false,
      money: 800,
      cmdQueue: [],
      lastCmdNum: 0,
      lastButtons: 0,
      yaw: 0,
      pitch: 0,
      cmdTokens: CMD_BURST,
      stats: { kills: 0, deaths: 0, assists: 0, damage: 0, score: 0, mvps: 0, hs: 0 },
      damageBy: new Map(), // attacker id -> damage this life (assists)
      netCache: new Map(),
      respawnAt: 0,
    };
  }

  addPlayer({ name, team, token }) {
    if (this.humanCount() >= MAX_PLAYERS) return null;
    const id = this.nextId();
    if (id < 0) return null;
    const p = this.createPlayer(id, name);
    p.token = token;
    p.money = this.hook('startMoney', p) ?? (this.mode === 'practice' ? ECONOMY.PRACTICE_MONEY : ECONOMY.START_MONEY);
    this.players.set(id, p);
    this.emit({ type: 'join', id, name: p.name, team: p.team });
    this.setTeam(p, team || this.autoTeam());
    return p;
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.dummy) n++;
    return n;
  }

  autoTeam() {
    let t = 0, ct = 0;
    for (const p of this.players.values()) {
      if (p.dummy) continue;
      if (p.team === TEAM.T) t++;
      else if (p.team === TEAM.CT) ct++;
    }
    return t <= ct ? TEAM.T : TEAM.CT;
  }

  requestTeam(p, team) {
    if (this.hook('canChangeTeam', p, team) === false) return;
    this.setTeam(p, team);
  }

  setTeam(p, team) {
    if (team !== TEAM.T && team !== TEAM.CT && team !== TEAM.SPEC) return;
    if (p.team === team) return;
    if (p.alive) this.killPlayer(p, null, 'teamchange', { silent: true });
    p.team = team;
    p.alive = false;
    this.emit({ type: 'team', id: p.id, team });
    if (team !== TEAM.SPEC && this.hook('canSpawnNow', p) !== false) this.spawnPlayer(p);
  }

  removePlayer(p) {
    if (p.alive) this.killPlayer(p, null, 'disconnect', { silent: true });
    this.players.delete(p.id);
    for (const other of this.players.values()) other.netCache.delete(p.id);
    this.emit({ type: 'leave', id: p.id });
  }

  disconnect(p) {
    p.connected = false;
    p.cmdQueue.length = 0;
    if (p.alive) this.killPlayer(p, null, 'disconnect', { silent: true });
    this.emit({ type: 'disconnect', id: p.id });
  }

  reconnect(p) {
    p.connected = true;
    p.cmdQueue.length = 0;
    p.netCache.clear();
    p.cmdTokens = CMD_BURST;
    this.emit({ type: 'reconnect', id: p.id });
    if (p.team !== TEAM.SPEC && !p.alive && this.hook('canSpawnNow', p) !== false) this.spawnPlayer(p);
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && !p.dummy) n++;
    return n;
  }

  teamName(p) { return TEAM_NAME[p.team]; }

  // ---- spawning ------------------------------------------------------------------
  spawnPlayer(p, { keepLoadout = false } = {}) {
    let spot;
    if (p.dummy) spot = p.dummy.spot;
    else spot = this.findFreeSpawn(p.team === TEAM.CT ? this.map.spawns.CT : this.map.spawns.T, p);
    const ps = createPlayerState();
    ps.pos[0] = spot[0]; ps.pos[1] = spot[1]; ps.pos[2] = spot[2];
    this.dropToFloor(ps);
    p.ps = ps;
    p.yaw = spot[3] || 0;
    p.pitch = 0;
    p.alive = true;
    p.health = 100;
    p.damageBy.clear();
    if (!keepLoadout) {
      const time = p.ws.time;
      defaultLoadout(p.ws, this.teamName(p) === 'CT' ? 'CT' : 'T');
      p.ws.time = time;
      if (this.mode === 'practice' && !p.dummy) {
        // Practice: spawn with the stage-3 test weapons and armor.
        giveWeapon(p.ws, 'usps');
        giveWeapon(p.ws, 'ak47');
        for (const n of ['he', 'flash', 'smoke', 'molotov']) giveWeapon(p.ws, n);
        p.ws.active = SLOT.PRIMARY;
        p.ws.last = SLOT.SECONDARY;
        p.armor = 100;
        p.helmet = true;
      }
    }
    if (p.dummy) {
      p.armor = p.dummy.armor || 0;
      p.helmet = !!p.dummy.helmet;
      if (p.dummy.duck) { ps.ducked = true; ps.duckAmount = 1; }
    }
    this.hook('onSpawn', p);
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

  // ---- damage & death ----------------------------------------------------------------
  canDamage(attacker, victim) {
    if (!attacker || attacker === victim) return true;
    if (victim.dummy || attacker.dummy || this.mode === 'practice') return true;
    if (attacker.team !== victim.team) return true;
    return !!this.friendlyFire;
  }

  killPlayer(p, attacker, weapon, opts = {}) {
    if (!p.alive) return;
    p.alive = false;
    p.health = 0;
    p.ps.vel[0] = p.ps.vel[1] = 0;
    const headshot = !!opts.headshot;
    if (!p.dummy) p.stats.deaths++;
    let assister = null;
    if (attacker && attacker !== p) {
      const teamKill = attacker.team === p.team && !p.dummy && this.mode !== 'practice';
      if (teamKill) attacker.stats.kills--;
      else attacker.stats.kills++;
      // CS2 kill rewards (team kills cost money)
      if (!attacker.dummy && this.mode !== 'practice') {
        const amount = teamKill ? ECONOMY.TEAMKILL_PENALTY : killReward(weapon);
        addMoney(attacker, amount);
        if (amount) this.emit({ type: 'money', amount, reason: teamKill ? 'Killed a teammate' : `Kill with ${WEAPONS[weapon]?.name || weapon}`, to: attacker.id });
      }
      if (headshot) attacker.stats.hs++;
      // assist: someone else who did 41+ damage this life (CS rule)
      let best = 0;
      for (const [id, dmg] of p.damageBy) {
        if (id === attacker.id || dmg <= 40) continue;
        if (dmg > best) { best = dmg; assister = this.players.get(id) || null; }
      }
      if (assister) assister.stats.assists++;
    }
    p.respawnAt = this.tick + (p.dummy ? TICK_RATE * 3 : this.mode === 'practice' ? TICK_RATE * 2 : Infinity);
    this.hook('onKill', p, attacker, weapon, { headshot, assister, ...opts });
    if (!opts.silent) {
      this.emit({
        type: 'kill', victim: p.id, attacker: attacker ? attacker.id : 0, assister: assister ? assister.id : 0,
        weapon: weapon || '', headshot, wallbang: !!opts.wallbang, pos: p.ps.pos.slice(),
      });
    }
  }

  /** Raw damage after armor has been worked out. */
  damagePlayer(p, healthDmg, armorDmg, attacker, weapon, info = {}) {
    if (!p.alive || healthDmg <= 0 && armorDmg <= 0) return;
    if (!this.canDamage(attacker, p)) return;
    const dealt = Math.min(p.health, healthDmg);
    p.health -= healthDmg;
    p.armor = Math.max(0, p.armor - armorDmg);
    if (p.armor === 0) p.helmet = false;
    if (attacker && attacker !== p) {
      p.damageBy.set(attacker.id, (p.damageBy.get(attacker.id) || 0) + dealt);
      attacker.stats.damage += dealt;
    }
    this.emit({
      type: 'damage', id: p.id, amount: Math.round(healthDmg), attacker: attacker ? attacker.id : 0,
      group: info.group ?? 0, weapon, from: info.from || null, to: p.id,
    });
    if (attacker && attacker !== p) {
      this.emit({ type: 'hit', id: p.id, amount: Math.round(dealt), group: info.group ?? 0, kill: p.health <= 0, to: attacker.id });
    }
    if (p.health <= 0) this.killPlayer(p, attacker, weapon, { headshot: info.group === HITGROUP.HEAD, wallbang: !!info.wallbang });
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

  isFrozen(p) {
    return this.hook('isFrozen', p) === true;
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
      p.ws.time = cmd.num * TICK_DT;
      return;
    }
    const frozen = this.isFrozen(p);
    const oldButtons = p.ps.oldButtons;
    const ctx = {
      world: this.world,
      dt: TICK_DT,
      maxSpeed: weaponMaxSpeed(p.ws),
      frozen,
      boxes: this.playerBoxes(p),
    };
    const ev = playerMove(p.ps, cmd, ctx);
    if (ev.footstep) this.emit({ type: 'step', id: p.id, pos: p.ps.pos.slice(), except: p.id });
    if (ev.landSpeed > PLAYER.FALL_PUNCH_THRESHOLD) this.emit({ type: 'land', id: p.id, speed: Math.round(ev.landSpeed), pos: p.ps.pos.slice(), except: p.id });
    if (ev.fallDamage > 0) this.damagePlayer(p, Math.floor(ev.fallDamage), 0, null, 'fall');
    if (!p.alive) return;
    if (p.ps.pos[2] < this.world.bounds.min[2] - 2000) { this.killPlayer(p, null, 'world'); return; }

    const wout = processWeapon(p.ps, p.ws, cmd, { frozen, oldButtons, playerId: p.id, weaponOut: (this._wout ||= {}) });
    this.handleWeaponOutput(p, cmd, wout);
  }

  // ---- weapons (server side effects) --------------------------------------------------
  handleWeaponOutput(p, cmd, out) {
    for (const shot of out.shots) this.resolveShot(p, cmd, shot);
    if (out.knife) this.resolveKnife(p, cmd, out.knife);
    if (out.reloadStart) this.emit({ type: 'reload', id: p.id, except: p.id });
    if (out.silencerToggle) this.emit({ type: 'silencer', id: p.id, except: p.id });
    if (out.throw) this.hook('onThrow', p, out.throw);
    if (out.drop) this.hook('onDrop', p, out.drop);
    this.hook('weaponOutput', p, cmd, out);
  }

  /** Where everyone was at a (fractional) tick in the past — lag compensation. */
  rewoundState(target, atTick) {
    const h = this.history;
    if (!h.length) return null;
    const t = Math.max(this.tick - MAX_UNLAG_TICKS, Math.min(this.tick, atTick));
    let i = h.length - 1;
    while (i > 0 && h[i].tick > t) i--;
    const a = h[i].states.get(target.id);
    const bEntry = h[i + 1];
    const b = bEntry ? bEntry.states.get(target.id) : null;
    if (!a) return b;
    if (!b || bEntry.tick === h[i].tick) return a;
    const f = Math.max(0, Math.min(1, (t - h[i].tick) / (bEntry.tick - h[i].tick)));
    if (!a.alive || !b.alive) return f < 0.5 ? a : b;
    return {
      pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * f, a.pos[1] + (b.pos[1] - a.pos[1]) * f, a.pos[2] + (b.pos[2] - a.pos[2]) * f],
      yaw: lerpAngle(a.yaw, b.yaw, f),
      duck: a.duck + (b.duck - a.duck) * f,
      alive: true,
    };
  }

  recordHistory() {
    const states = new Map();
    for (const p of this.players.values()) {
      states.set(p.id, { pos: p.ps.pos.slice(), yaw: p.yaw, duck: p.ps.duckAmount, alive: p.alive });
    }
    this.history.push({ tick: this.tick, states });
    while (this.history.length > LAG_COMP_TICKS + 2) this.history.shift();
  }

  /** Builds the player-hit test used by bullets, rewound to what the shooter saw. */
  playerTester(shooter, cmd, pad = 0) {
    // Dummies and the local practice player: rewind to the client's view time.
    const atTick = shooter.dummy ? this.tick : (cmd.interp > 0 ? cmd.interp : this.tick);
    const targets = [];
    for (const o of this.players.values()) {
      if (o === shooter) continue;
      const st = this.rewoundState(o, atTick) || { pos: o.ps.pos, yaw: o.yaw, duck: o.ps.duckAmount, alive: o.alive };
      if (!st.alive || !o.alive) continue;
      targets.push({ id: o.id, st });
    }
    return (start, dir, maxDist, exclude) => {
      let best = null;
      for (const tg of targets) {
        if (exclude && exclude.has(tg.id)) continue;
        const h = rayPlayer(start, dir, maxDist, tg.st.pos, tg.st.yaw, tg.st.duck, this._caps, pad);
        if (h && (!best || h.t < best.t)) best = { t: h.t, group: h.group, id: tg.id };
      }
      return best;
    };
  }

  resolveShot(p, cmd, shot) {
    const def = WEAPONS[shot.weapon];
    const test = this.playerTester(p, cmd);
    const ends = [];
    const impacts = [];
    for (const dir of shot.dirs) {
      const res = traceBullet(this.world, shot.origin, dir, def, test, p.id);
      ends.push(res.end.map((v) => Math.round(v * 10) / 10));
      for (const im of res.impacts) impacts.push([...im.pos.map((v) => Math.round(v * 10) / 10), ...im.normal.map((v) => Math.round(v * 100) / 100)]);
      for (const hit of res.hits) {
        const victim = this.players.get(hit.id);
        if (!victim || !victim.alive || !this.canDamage(p, victim)) continue;
        const dmg = computeDamage(hit.damage, hit.group, def.armorPen, victim);
        applyHitEffects(victim.ps, victim.ws, dmg.health, def.tag ?? 0.5);
        this.damagePlayer(victim, dmg.health, dmg.armor, p, def.id, {
          group: hit.group, from: shot.origin, wallbang: res.impacts.length > 0 && res.impacts[0].pos && distSq(res.impacts[0].pos, shot.origin) < hit.dist * hit.dist,
        });
        this.emit({ type: 'blood', pos: hit.pos.map((v) => Math.round(v)), dir: dir.map((v) => Math.round(v * 100) / 100), head: hit.group === HITGROUP.HEAD });
      }
    }
    this.emit({
      type: 'shot', id: p.id, weapon: def.id, origin: shot.origin.map((v) => Math.round(v * 10) / 10), ends, impacts,
      silenced: shot.silenced, except: p.id,
    });
  }

  resolveKnife(p, cmd, k) {
    const def = WEAPONS[k.weapon];
    const end = [k.origin[0] + k.dir[0] * k.range, k.origin[1] + k.dir[1] * k.range, k.origin[2] + k.dir[2] * k.range];
    this.world.traceRay(k.origin, end, this._tr);
    const wallDist = this._tr.hit ? this._tr.fraction * k.range : k.range;
    // knives are forgiving: test a fatter ray, then a slightly wider cone
    const test = this.playerTester(p, cmd, 6);
    let hit = test(k.origin, k.dir, wallDist, null);
    if (!hit) {
      for (const [dy, dz] of [[0.12, 0], [-0.12, 0], [0, 0.1], [0, -0.1]]) {
        const d = [k.dir[0] + dy * -k.dir[1], k.dir[1] + dy * k.dir[0], k.dir[2] + dz];
        const l = Math.hypot(d[0], d[1], d[2]);
        hit = test(k.origin, [d[0] / l, d[1] / l, d[2] / l], wallDist, null);
        if (hit) break;
      }
    }
    if (!hit) {
      this.emit({ type: 'knife', id: p.id, kind: k.kind, hitWorld: this._tr.hit, pos: this._tr.endpos.map(Math.round), except: p.id });
      return;
    }
    const victim = this.players.get(hit.id);
    if (!victim) return;
    // backstab: we're behind them (they face away from us)
    const vy = (victim.yaw * Math.PI) / 180;
    const vf = [Math.cos(vy), Math.sin(vy)];
    const to = [victim.ps.pos[0] - p.ps.pos[0], victim.ps.pos[1] - p.ps.pos[1]];
    const tl = Math.hypot(to[0], to[1]) || 1;
    const backstab = (vf[0] * to[0] + vf[1] * to[1]) / tl > 0.475;
    const raw = backstab ? k.backstab : k.damage;
    const dmg = computeDamage(raw, HITGROUP.GENERIC, def.armorPen, victim);
    applyHitEffects(victim.ps, victim.ws, dmg.health, def.tag);
    this.damagePlayer(victim, dmg.health, dmg.armor, p, def.id, { group: HITGROUP.CHEST, from: k.origin });
    this.emit({ type: 'knife', id: p.id, kind: k.kind, hitPlayer: victim.id, backstab, except: p.id });
  }

  // ---- buying ----------------------------------------------------------------------------
  canBuy(p) {
    if (!p.alive || (p.team !== TEAM.T && p.team !== TEAM.CT)) return false;
    const rule = this.hook('canBuy', p);
    if (rule !== undefined) return rule;
    if (this.mode === 'practice') return true;
    const zone = this.map.buyzones && this.map.buyzones[this.teamName(p)];
    return inBox(p.ps.pos, zone);
  }

  buy(p, item) {
    if (!this.canBuy(p)) { this.emit({ type: 'buyResult', ok: false, item, reason: 'You can only buy in your buy zone during buy time', to: p.id }); return; }
    const res = tryBuy(p, item, this.teamName(p));
    if (res.ok && res.dropped) {
      const eye = this.eyeOf(p);
      this.items.spawn(res.dropped.id, res.dropped, [eye[0], eye[1], eye[2] - 20], [p.ps.vel[0], p.ps.vel[1], 80], p.id);
    }
    if (res.ok && this.mode === 'practice') p.money = ECONOMY.PRACTICE_MONEY;
    this.emit({ type: 'buyResult', ok: res.ok, item, reason: res.reason || '', price: res.price || 0, to: p.id });
  }

  // ---- practice mode: target dummies -----------------------------------------------------
  setupPractice() {
    // [x, y, z, yaw, options] — placed around T spawn, facing the player
    const D = [
      [-1500, -460, 130, 270, { name: 'Dummy (no armor)' }],
      [-1380, -460, 130, 270, { name: 'Dummy (kevlar+helmet)', armor: 100, helmet: true }],
      [-1260, -460, 130, 270, { name: 'Dummy (crouching)', duck: true, armor: 100 }],
      [-1650, -300, 130, 270, { name: 'Dummy (strafing)', strafe: true, armor: 100, helmet: true }],
      [-1900, -800, 130, 0, { name: 'Dummy (far)', armor: 100, helmet: true }],
    ];
    for (const [x, y, z, yaw, o] of D) this.addDummy([x, y, z, yaw], o);
  }

  addDummy(spot, opts = {}) {
    const id = this.nextId();
    if (id < 0) return null;
    const p = this.createPlayer(id, opts.name || 'Dummy');
    p.dummy = { spot, ...opts, cmdNum: 0 };
    p.team = opts.team || TEAM.CT;
    this.players.set(id, p);
    this.spawnPlayer(p);
    return p;
  }

  runDummy(p) {
    if (!p.alive || !p.dummy.strafe) return;
    const c = createCmd();
    c.num = ++p.dummy.cmdNum;
    c.yaw = p.dummy.spot[3];
    // strafe left/right, changing direction every 1.2 s (and counter-strafing)
    const phase = Math.floor(this.tick / (TICK_RATE * 1.2)) % 2;
    c.buttons = phase ? IN.MOVELEFT : IN.MOVERIGHT;
    this.runCommand(p, c);
  }

  // ---- the 64-tick loop ----------------------------------------------------------------
  step() {
    this.tick++;
    for (const p of this.players.values()) {
      if (p.dummy) { this.runDummy(p); continue; }
      if (!p.connected) continue;
      p.cmdTokens = Math.min(CMD_BURST, p.cmdTokens + 1);
      // Normally run 1 command per tick; catch up if the client's queue grew.
      let n = p.cmdQueue.length > 4 ? p.cmdQueue.length - 2 : Math.min(1, p.cmdQueue.length);
      while (n-- > 0 && p.cmdTokens >= 1) {
        p.cmdTokens -= 1;
        this.runCommand(p, p.cmdQueue.shift());
      }
      // Anti speed-hack: a client can never run more commands than real time
      // allows (+ a small catch-up budget). Way too many queued = cheating/flooding.
      if (p.cmdQueue.length > MAX_QUEUED_CMDS - 16) p.cmdQueue.splice(0, p.cmdQueue.length - CMD_BURST);
    }
    this.hook('update');
    for (const p of this.players.values()) {
      if (!p.alive && p.team !== TEAM.SPEC && this.tick >= p.respawnAt && (p.connected || p.dummy)) this.spawnPlayer(p);
    }
    this.recordHistory();
  }

  /** The server skipped ticks (it was busy): give everyone that time back. */
  grantTicks(n) {
    for (const p of this.players.values()) p.cmdTokens = Math.min(CMD_BURST, p.cmdTokens + n);
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
    const def = activeWeapon(p.ws);
    const reloading = p.ws.reloadEnd > 0 || p.ws.shellState > 0;
    e.flags = (p.alive ? EFLAG.ALIVE : 0) | (p.ps.onGround ? EFLAG.ON_GROUND : 0) | (p.ps.ducked ? EFLAG.DUCKED : 0) |
      ((p.lastButtons & IN.WALK) ? EFLAG.WALKING : 0) | (p.ws.zoom > 0 ? EFLAG.SCOPED : 0) | (reloading ? EFLAG.RELOADING : 0) |
      (p.defusing ? EFLAG.DEFUSING : 0) | (p.planting ? EFLAG.PLANTING : 0);
    e.weapon = def ? def.index : 0;
    const flags = p.ws.active === SLOT.PRIMARY ? p.ws.priFlags : p.ws.active === SLOT.SECONDARY ? p.ws.secFlags : 0;
    e.wflags = (flags & FLAG.SILENCER_ON ? 1 : 0) | (p.helmet ? 2 : 0) | (p.defuser ? 4 : 0) | (p.ws.c4 ? 8 : 0) | (p.dummy ? 16 : 0);
    e.health = p.alive ? p.health : 0;
    e.armor = p.armor;
    e.vel = p.ps.vel.slice();
    e.team = p.team;
    return e;
  }

  /** Extra predicted state appended to each snapshot (weapons/inventory). */
  writePredicted(w, p) {
    writeSchema(w, p.ws, WEAPON_SCHEMA);
  }

  /** World entities in every snapshot (flying grenades). */
  writeWorld(w, p) {
    void p;
    this.grenades.writeWorld(w);
  }

  /** Everything a player joining mid-game needs to see. */
  publicState() {
    return { ...this.grenades.publicState(), ...this.items.publicState(), ...(this.hook('publicRoundState') || {}) };
  }

  /** Scoreboard rows as seen by `viewer` (money only shown for teammates). */
  scoreboard(viewer) {
    const rounds = Math.max(1, this.roundsPlayed || 0);
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, alive: p.alive, connected: p.connected || !!p.dummy, bot: !!p.dummy,
      kills: p.stats.kills, deaths: p.stats.deaths, assists: p.stats.assists, score: p.stats.score + p.stats.kills * 2 + p.stats.assists,
      adr: Math.round(p.stats.damage / rounds), ping: p.dummy ? 0 : p.ping ?? 0,
      money: viewer && (viewer.team === p.team || this.mode === 'practice') ? p.money : undefined,
    }));
  }

  publicInfo() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, connected: p.connected, alive: p.alive, stats: p.stats, dummy: !!p.dummy,
    }));
  }

  eyeOf(p) { return eyePos(p.ps); }
}

function lerpAngle(a, b, t) {
  const d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

function distSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function sanitizeName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} _\-.!?()+]/gu, '').trim().slice(0, 24);
  return s || 'Player';
}
