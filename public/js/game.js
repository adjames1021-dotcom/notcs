// ---------------------------------------------------------------------------
// game.js — the client game loop.
//
// Every 1/64 s (one tick):
//   1. read input -> build a usercmd
//   2. PREDICT: run the shared movement code on it right away (no waiting)
//   3. send commands to the server, 2 per message (8 while dead: saves cost)
// When a server snapshot arrives:
//   4. RECONCILE: compare the server's result for the last command it ran
//      with what we predicted. If different, rewind to the server's state
//      and replay the commands it hasn't seen yet.
//   5. INTERPOLATE other players ~100 ms in the past between snapshots.
// Rendering runs as fast as the screen allows and blends between ticks.
//
// If the connection drops, the game pauses where it is and reconnects by
// itself (your player is kept for 10 s on the server), instead of going back
// to the menu.
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE, PLAYER } from '../shared/constants.js';
import {
  createPlayerState, copyPlayerState, playerMove, spectatorMove, eyeHeight, playerStateError, getHull,
} from '../shared/movement.js';
import { createCmd, copyCmd, IN } from '../shared/usercmd.js';
import {
  MSG, MOVE_SCHEMA, encodeCmds, quantizeCmd, newReader, readSchema, readEntity, EFLAG,
} from '../shared/protocol.js';
import {
  createWeaponState, copyWeaponState, weaponStateError, processWeapon, weaponMaxSpeed, WEAPON_SCHEMA,
} from '../shared/weaponLogic.js';

export const INTERP_DELAY_MS = 100; // how far in the past other players are drawn
const INTERP_TICKS = (INTERP_DELAY_MS / 1000) * TICK_RATE;
const CMDS_PER_PACKET = 2;
const CMDS_PER_PACKET_DEAD = 8; // dead/spectating: input latency doesn't matter
const MAX_HISTORY = 256;
const CLOSE_IDLE = 4001; // server: "you were idle" (see shared/server.js)
const STALL_MS = 5000; // no data for this long while the tab is visible = connection dead
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 3000];
const RECONNECT_GIVE_UP_MS = 60000;

export class Game {
  constructor({ renderer, input, transport, world, settings, hud, audio, mode, players }) {
    this.renderer = renderer;
    this.input = input;
    this.transport = transport;
    this.world = world;
    this.settings = settings;
    this.hud = hud;
    this.audio = audio;
    this.mode = mode;
    this.playersView = players; // render/players.js

    // --- local player prediction ---
    this.localId = 0;
    this.alive = false;
    this.frozen = false;
    this.team = 0;
    this.pred = createPlayerState();
    this.predPrev = createPlayerState();
    this.ws = createWeaponState(); // predicted weapons/inventory
    this.history = []; // [{ cmd, state, ws }] commands the server hasn't confirmed
    this.cmdNum = 0;
    this.cmdsPerPacket = CMDS_PER_PACKET; // the server can change it (welcome)
    this.outBatch = [];
    this.smoothOffset = [0, 0, 0]; // hides small prediction corrections
    this.hudState = { health: 0, armor: 0, money: 0, helmet: false, defuser: false, team: 0 };

    // --- other players ---
    this.entities = new Map(); // id -> { latest, buffer: [{tick, state}] }
    this.roster = new Map(); // id -> { name, team, ... }
    this.serverTick = 0;
    this.serverTickEst = 0;
    this.tickEstReady = false;

    // --- timing / stats ---
    this.accumulator = 0;
    this.lastFrame = 0;
    this.running = false;
    this.cmdSendTime = new Map();
    this.ping = 0;
    this.stats = { corrections: 0, lastError: 0, maxError: 0, snapshots: 0, bytesIn: 0, msgsOut: 0, fps: 0 };
    this.statWindow = { t: 0, frames: 0, snaps: 0, bytes: 0, out: 0 };
    this.debug = false;
    this.listeners = {};

    // --- connection ---
    this.connState = 'connected'; // 'connected' | 'reconnecting' | 'idle'
    this.joinInfo = null;
    this.lastMessageAt = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.lostAt = 0;
    this.kickReason = null;
    this.stats.reconnects = 0;
    this.stats.lastClose = '';
  }

  on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); }
  emit(name, ...args) { for (const fn of this.listeners[name] || []) fn(...args); }

  // ---- connection -------------------------------------------------------------------
  start(name, lobbyToken) {
    this.transport.onmessage = (data) => this.onMessage(data);
    this.transport.onclose = (e) => this.onConnectionLost(e);
    this.joinInfo = { name, token: lobbyToken || undefined };
    this.sendJoin();
    this.running = true;
    this.lastFrame = performance.now();
    this.lastMessageAt = this.lastFrame;
    const loop = (t) => {
      if (!this.running) return;
      this.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    this.transport.close();
  }

  sendJoin() {
    this.transport.send(JSON.stringify({ type: 'join', name: this.joinInfo.name, token: this.joinInfo.token }));
  }

  // ---- losing and regaining the connection -------------------------------------------
  onConnectionLost(e = {}) {
    if (!this.running) return;
    if (this.fatalError) { this.emit('disconnected', this.fatalError); return; }
    if (this.mode !== 'online') { this.emit('disconnected', 'Disconnected.'); return; }
    const code = e.code ?? 0;
    if (this.connState === 'connected') {
      this.lostAt = performance.now();
      this.reconnectAttempt = 0;
      this.stats.reconnects++;
      this.stats.lastClose = `code ${code}${e.reason ? ' (' + e.reason + ')' : ''}`;
      console.warn(`[net] connection lost: ${this.stats.lastClose}`);
    }
    if (code === CLOSE_IDLE || this.kickReason === 'idle') {
      // The tab was in the background for a minute. Rejoin when it's back.
      this.kickReason = null;
      this.connState = 'idle';
      this.emit('connection', { state: 'idle' });
      this.onVisible = () => {
        if (document.visibilityState !== 'visible' || this.connState !== 'idle') return;
        document.removeEventListener('visibilitychange', this.onVisible);
        this.lostAt = performance.now();
        this.tryReconnect();
      };
      document.addEventListener('visibilitychange', this.onVisible);
      this.onVisible();
      return;
    }
    this.connState = 'reconnecting';
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (!this.running) return;
    if (performance.now() - this.lostAt > RECONNECT_GIVE_UP_MS) {
      this.emit('disconnected', `Lost connection to the server (${this.stats.lastClose}).`);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.emit('connection', { state: 'reconnecting', attempt: this.reconnectAttempt, lastClose: this.stats.lastClose });
    this.reconnectTimer = setTimeout(() => this.tryReconnect(), delay);
  }

  async tryReconnect() {
    if (!this.running) return;
    this.connState = 'reconnecting';
    try {
      await this.transport.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (!this.running) { this.transport.close(); return; }
    this.lastMessageAt = performance.now();
    this.sendJoin(); // the server's 'welcome' finishes the reconnect (onWelcome)
  }

  /** First join and every rejoin. */
  onWelcome(msg) {
    const rejoin = this.localId !== 0;
    this.localId = msg.id;
    this.serverMode = msg.mode; // 'practice' | 'deathmatch' | 'defusal' | 'casual'
    if (this.joinInfo) this.joinInfo.token = msg.token;
    // Carry on numbering commands where the server's copy of us left off.
    this.cmdNum = Math.max(this.cmdNum, msg.cmdBase || 0);
    if (msg.cmdsPerMessage) this.cmdsPerPacket = msg.cmdsPerMessage;
    this.history.length = 0;
    this.outBatch = [];
    this.cmdSendTime.clear();
    this.lastAck = -1;
    this.lastServer = null;
    this.lastServerWs = null;
    this.serverTick = msg.tick;
    this.serverTickEst = msg.tick;
    this.tickEstReady = true;
    if (rejoin) {
      for (const id of this.entities.keys()) this.playersView?.remove(id);
      this.entities.clear();
      this.roster.clear();
    }
    for (const p of msg.players) this.roster.set(p.id, p);
    const wasLost = this.connState !== 'connected';
    this.connState = 'connected';
    this.reconnectAttempt = 0;
    if (wasLost) {
      console.log(`[net] reconnected after ${Math.round(performance.now() - this.lostAt)} ms`);
      this.emit('connection', { state: 'connected' });
    }
  }

  onMessage(data) {
    this.lastMessageAt = performance.now();
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this.onJson(msg);
      return;
    }
    this.statWindow.bytes += data.byteLength;
    const r = newReader(data);
    const type = r.u8();
    if (type === MSG.SNAPSHOT) this.onSnapshot(r);
  }

  onJson(msg) {
    switch (msg.type) {
      case 'welcome':
        this.onWelcome(msg);
        this.emit('welcome', msg);
        break;
      case 'kicked':
        this.kickReason = msg.reason;
        break;
      case 'ev':
        for (const ev of msg.list) this.onEvent(ev);
        break;
      case 'error':
        this.fatalError = msg.message; // e.g. "Match is full": don't keep retrying
        this.emit('error', msg.message);
        break;
      default:
        this.emit(msg.type, msg);
    }
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'join':
        this.roster.set(ev.id, { id: ev.id, name: ev.name, team: ev.team, connected: true });
        break;
      case 'leave':
        this.roster.delete(ev.id);
        this.entities.delete(ev.id);
        this.playersView?.remove(ev.id);
        break;
      case 'team': {
        const r = this.roster.get(ev.id);
        if (r) r.team = ev.team;
        if (ev.id === this.localId) this.team = ev.team;
        break;
      }
      case 'spawn':
        if (ev.id === this.localId) {
          this.input.yaw = ev.yaw;
          this.input.pitch = 0;
          this.smoothOffset = [0, 0, 0];
        }
        break;
      case 'step':
        this.audio.footstep(ev.pos);
        break;
      case 'land':
        this.audio.land(ev.pos, ev.speed);
        break;
      case 'damage':
        if (ev.id === this.localId) this.audio.hurt();
        break;
      default:
        break;
    }
    this.emit('event', ev);
  }

  // ---- snapshots + reconciliation -----------------------------------------------------
  onSnapshot(r) {
    const tick = r.u32();
    if (tick < this.serverTick) return; // stale (never happens on an ordered connection)
    const ack = r.u32();
    const flags = r.u8();
    const server = readSchema(r, createPlayerState(), MOVE_SCHEMA);
    const serverWs = readSchema(r, createWeaponState(), WEAPON_SCHEMA);
    const hs = this.hudState;
    hs.health = r.u8();
    hs.armor = r.u8();
    const hf = r.u8();
    hs.helmet = !!(hf & 1);
    hs.defuser = !!(hf & 2);
    hs.money = r.u32();
    hs.team = r.u8();
    this.team = hs.team;

    this.stats.snapshots++;
    this.statWindow.snaps++;
    this.serverTick = tick;
    if (!this.tickEstReady) { this.serverTickEst = tick; this.tickEstReady = true; }
    const err = tick - this.serverTickEst;
    if (Math.abs(err) > 16) this.serverTickEst = tick;
    else this.serverTickEst += err * 0.05;

    // ping = time from sending a command until the server confirms it
    const sent = this.cmdSendTime.get(ack);
    if (sent !== undefined) {
      const rtt = performance.now() - sent;
      this.ping = this.ping ? this.ping * 0.9 + rtt * 0.1 : rtt;
      for (const k of this.cmdSendTime.keys()) if (k <= ack) this.cmdSendTime.delete(k);
    }

    this.alive = !!(flags & 1);
    this.frozen = !!(flags & 2);
    this.weaponsFrozen = !!(flags & 4);
    this.reconcile(ack, server, serverWs);

    // other players
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const u = readEntity(r, this.entityStore());
      if (u.removed) {
        this.entities.delete(u.id);
        this.playersView?.remove(u.id);
        continue;
      }
      let ent = this.entities.get(u.id);
      if (!ent) { ent = { latest: u.state, buffer: [] }; this.entities.set(u.id, ent); }
      ent.latest = u.state;
    }
    for (const ent of this.entities.values()) {
      ent.buffer.push({ tick, state: ent.latest });
      while (ent.buffer.length > 2 && ent.buffer[0].tick < tick - TICK_RATE) ent.buffer.shift();
    }
    this.readWorldExtra(r, tick);
  }

  entityStore() {
    if (!this._store) {
      this._store = { get: (id) => { const e = this.entities.get(id); return e ? { ...e.latest, pos: e.latest.pos.slice(), vel: e.latest.vel.slice() } : undefined; } };
    }
    return this._store;
  }

  // hook for later stages (world entities like grenades)
  readWorldExtra(r, tick) { void r; void tick; }

  reconcile(ack, server, serverWs) {
    // Same command acknowledged again and nothing changed: nothing to do.
    if (ack === this.lastAck && this.lastServer && playerStateError(server, this.lastServer) === 0 &&
      weaponStateError(serverWs, this.lastServerWs) === 0) return;
    this.lastAck = ack;
    this.lastServer = server;
    this.lastServerWs = serverWs;
    // forget commands the server has already processed
    while (this.history.length && this.history[0].cmd.num < ack) this.history.shift();
    const entry = this.history.length && this.history[0].cmd.num === ack ? this.history.shift() : null;
    if (entry) {
      const error = Math.max(playerStateError(entry.state, server), weaponStateError(entry.ws, serverWs) > 1e-9 ? 1 : 0);
      this.stats.lastError = error;
      if (error > this.stats.maxError) this.stats.maxError = error;
      if (error < 1e-6) return; // prediction was perfect
      this.stats.lastMismatch = describeMismatch(entry, server, serverWs);
    } else {
      this.stats.lastMismatch = 'no matching command (join/respawn)';
    }

    // Rewind to the server's truth and replay everything it hasn't seen yet.
    this.stats.corrections++;
    const before = this.pred.pos.slice();
    const st = createPlayerState();
    const ws = createWeaponState();
    copyPlayerState(st, server);
    copyWeaponState(ws, serverWs);
    for (const h of this.history) {
      this.simulate(st, ws, h.cmd, true);
      copyPlayerState(h.state, st);
      copyWeaponState(h.ws, ws);
    }
    copyPlayerState(this.pred, st);
    copyWeaponState(this.ws, ws);
    const dx = before[0] - st.pos[0], dy = before[1] - st.pos[1], dz = before[2] - st.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 64) {
      // small error: hide it by blending the camera over a few frames
      this.smoothOffset[0] += dx; this.smoothOffset[1] += dy; this.smoothOffset[2] += dz;
    } else {
      // teleport/respawn: snap
      this.smoothOffset = [0, 0, 0];
      copyPlayerState(this.predPrev, st);
    }
  }

  /** One predicted tick for the local player — same code as the server runs. */
  simulate(ps, ws, cmd, replay) {
    if (!this.alive) { spectatorMove(ps, cmd); ws.time = cmd.num * TICK_DT; return null; }
    const oldButtons = ps.oldButtons;
    const ev = playerMove(ps, cmd, {
      world: this.world,
      dt: TICK_DT,
      maxSpeed: weaponMaxSpeed(ws),
      frozen: this.frozen,
      boxes: this.otherPlayerBoxes(),
    });
    if (!replay) this.onPredictedEvents(ev);
    const out = processWeapon(ps, ws, cmd, { frozen: this.weaponsFrozen, oldButtons, playerId: this.localId, weaponOut: (this._wout ||= {}) });
    if (!replay) this.onPredictedWeapon(out, ps, ws);
    return ev;
  }

  onPredictedWeapon(out, ps, ws) { void out; void ps; void ws; }

  otherPlayerBoxes() {
    const boxes = [];
    for (const [id, ent] of this.entities) {
      const s = ent.render || ent.latest;
      if (!s || !(s.flags & EFLAG.ALIVE)) continue;
      const h = (s.flags & EFLAG.DUCKED) ? 54 : 72;
      boxes.push({ id, min: [s.pos[0] - 16, s.pos[1] - 16, s.pos[2]], max: [s.pos[0] + 16, s.pos[1] + 16, s.pos[2] + h] });
    }
    return boxes;
  }

  onPredictedEvents(ev) {
    if (ev.footstep) this.audio.footstep(null, 0.7);
    if (ev.landSpeed > PLAYER.FALL_PUNCH_THRESHOLD) this.audio.land(null, ev.landSpeed);
    this.emit('predicted', ev);
  }

  // ---- the frame loop -----------------------------------------------------------------------
  frame(now) {
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.25) dt = 0.25; // tab was in the background
    this.accumulator += dt;
    this.serverTickEst += dt * TICK_RATE;
    if (this.mode === 'online' && this.connState === 'connected' && now - this.lastMessageAt > STALL_MS &&
      document.visibilityState === 'visible') {
      // Nothing from the server for 5 s: the connection is dead even if the
      // browser hasn't noticed yet. Drop it and reconnect.
      this.transport.close();
      this.onConnectionLost({ code: 0, reason: 'no data from server' });
    }
    while (this.accumulator >= TICK_DT) {
      this.accumulator -= TICK_DT;
      this.tick();
    }
    // fade out prediction-correction offset (~100 ms)
    const k = Math.exp(-dt * 20);
    for (let i = 0; i < 3; i++) this.smoothOffset[i] *= k;

    this.updateStats(now, dt);
    this.renderFrame(this.accumulator / TICK_DT, dt);
  }

  tick() {
    if (!this.localId || this.connState !== 'connected') return; // paused while reconnecting
    const cmd = createCmd();
    cmd.num = ++this.cmdNum;
    cmd.buttons = this.input.sampleButtons();
    cmd.yaw = this.input.yaw;
    cmd.pitch = this.input.pitch;
    cmd.select = this.input.takeSelect();
    cmd.impulse = this.input.takeImpulse();
    cmd.interp = Math.max(0, this.serverTickEst - INTERP_TICKS);
    if (!this.alive && this.spectating) {
      const pressed = cmd.buttons & ~(this.lastSpecButtons || 0);
      if (pressed & IN.ATTACK) this.cycleSpectate(1);
      else if (pressed & IN.ATTACK2) this.cycleSpectate(-1);
    }
    this.lastSpecButtons = cmd.buttons;
    quantizeCmd(cmd);
    this.beforeTick(cmd);

    copyPlayerState(this.predPrev, this.pred);
    this.simulate(this.pred, this.ws, cmd, false);
    this.history.push({
      cmd: copyCmd(createCmd(), cmd),
      state: copyPlayerState(createPlayerState(), this.pred),
      ws: copyWeaponState(createWeaponState(), this.ws),
    });
    if (this.history.length > MAX_HISTORY) this.history.shift();

    this.outBatch.push(cmd);
    this.cmdSendTime.set(cmd.num, performance.now());
    if (this.outBatch.length >= (this.alive ? this.cmdsPerPacket : CMDS_PER_PACKET_DEAD)) {
      this.transport.send(encodeCmds(this.outBatch));
      this.outBatch = [];
      this.statWindow.out++;
    }
  }

  beforeTick(cmd) { void cmd; }

  // ---- rendering --------------------------------------------------------------------------
  /** Where the local camera is this frame (interpolated between ticks). */
  eyePosition(alpha) {
    const a = this.predPrev, b = this.pred;
    const eh = this.alive ? eyeHeight(a) + (eyeHeight(b) - eyeHeight(a)) * alpha : 0;
    return [
      a.pos[0] + (b.pos[0] - a.pos[0]) * alpha + this.smoothOffset[0],
      a.pos[1] + (b.pos[1] - a.pos[1]) * alpha + this.smoothOffset[1],
      a.pos[2] + (b.pos[2] - a.pos[2]) * alpha + this.smoothOffset[2] + eh,
    ];
  }

  renderTick() {
    return this.serverTickEst - INTERP_TICKS;
  }

  /** Other players' state at the render time (100 ms ago). */
  interpolateEntity(ent, rt) {
    const buf = ent.buffer;
    if (!buf.length) return ent.latest;
    if (rt <= buf[0].tick) return buf[0].state;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].tick <= rt) {
        const a = buf[i], b = buf[i + 1];
        if (!b) return a.state; // no newer data: hold (don't extrapolate)
        const t = (rt - a.tick) / (b.tick - a.tick);
        return lerpEntity(a.state, b.state, t);
      }
    }
    return buf[buf.length - 1].state;
  }

  renderFrame(alpha, dt) {
    let eye = this.eyePosition(alpha);
    const rt = this.renderTick();
    for (const [id, ent] of this.entities) {
      ent.render = this.interpolateEntity(ent, rt);
      this.playersView?.update(id, ent.render, this.roster.get(id), dt);
    }
    const punch = this.viewPunch ? this.viewPunch() : [0, 0];
    let yaw = this.input.yaw + punch[1], pitch = this.input.pitch + punch[0];
    // Dead in bomb defusal: watch through a living teammate's eyes (CS2).
    const spec = this.spectateView();
    if (spec) {
      eye = spec.eye; yaw = spec.yaw; pitch = spec.pitch;
      const v = this.playersView?.views.get(this.spectating);
      if (v) v.visible = false; // don't draw the body we're inside
    }
    this.viewEye = eye;
    this.renderer.setView(eye, yaw, pitch);
    this.audio.setListener(eye, yaw);
    this.beforeRender(alpha, dt);
    this.renderer.render();
    this.hud?.update(this);
  }

  beforeRender(alpha, dt) { void alpha; void dt; }

  /** Living teammates we could spectate, in a stable order. */
  spectateTargets() {
    const out = [];
    for (const [id, ent] of this.entities) {
      const s = ent.render || ent.latest;
      if (s && (s.flags & EFLAG.ALIVE) && s.team === this.team && !(s.wflags & 16)) out.push(id);
    }
    return out.sort((a, b) => a - b);
  }

  /** Camera for spectating, or null (alive, deathmatch, nobody to watch). */
  spectateView() {
    const rounds = this.serverMode === 'defusal' || this.serverMode === 'casual';
    if (this.alive || !rounds || (this.team !== 1 && this.team !== 2)) { this.spectating = 0; return null; }
    const targets = this.spectateTargets();
    if (!targets.length) { this.spectating = 0; return null; }
    if (!targets.includes(this.spectating)) this.spectating = targets[0];
    const s = this.entities.get(this.spectating).render;
    const eyeZ = PLAYER.EYE_STAND + (PLAYER.EYE_DUCK - PLAYER.EYE_STAND) * s.duck;
    return { eye: [s.pos[0], s.pos[1], s.pos[2] + eyeZ], yaw: s.yaw, pitch: s.pitch };
  }

  /** Click while spectating: next teammate (right click: previous). */
  cycleSpectate(dir) {
    const t = this.spectateTargets();
    if (t.length < 2) return;
    const i = t.indexOf(this.spectating);
    this.spectating = t[(i + dir + t.length) % t.length];
  }

  updateStats(now, dt) {
    void dt;
    const w = this.statWindow;
    w.frames++;
    if (now - (this.lastPingReport || 0) > 2000 && this.localId) {
      this.lastPingReport = now;
      this.transport.send(JSON.stringify({ type: 'ping', ping: Math.round(this.ping) }));
    }
    if (now - w.t >= 1000) {
      const secs = (now - w.t) / 1000;
      this.stats.fps = Math.round(w.frames / secs);
      this.stats.snapRate = Math.round(w.snaps / secs);
      this.stats.kbIn = (w.bytes / 1024 / secs).toFixed(1);
      this.stats.msgsOut = Math.round(w.out / secs);
      w.t = now; w.frames = 0; w.snaps = 0; w.bytes = 0; w.out = 0;
    }
  }

  localHull() { return getHull(this.pred); }
}

function lerpAngle(a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

export function lerpEntity(a, b, t) {
  return {
    ...b,
    pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * t, a.pos[1] + (b.pos[1] - a.pos[1]) * t, a.pos[2] + (b.pos[2] - a.pos[2]) * t],
    yaw: lerpAngle(a.yaw, b.yaw, t),
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    duck: a.duck + (b.duck - a.duck) * t,
    vel: [a.vel[0] + (b.vel[0] - a.vel[0]) * t, a.vel[1] + (b.vel[1] - a.vel[1]) * t, a.vel[2] + (b.vel[2] - a.vel[2]) * t],
  };
}

/** Which fields differ between our prediction and the server (debug overlay). */
function describeMismatch(entry, server, serverWs) {
  const diffs = [];
  for (const k of ['onGround', 'ducked', 'duckAmount', 'stamina', 'velocityModifier']) {
    if (entry.state[k] !== server[k]) diffs.push(k);
  }
  for (let i = 0; i < 3; i++) {
    if (entry.state.pos[i] !== server.pos[i]) { diffs.push('pos'); break; }
  }
  for (let i = 0; i < 3; i++) {
    if (entry.state.vel[i] !== server.vel[i]) { diffs.push('vel'); break; }
  }
  for (const [k] of WEAPON_SCHEMA) if (entry.ws[k] !== serverWs[k]) diffs.push('ws.' + k);
  return diffs.join(', ') || 'tiny';
}
