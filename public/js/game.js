// ---------------------------------------------------------------------------
// game.js — the client game loop.
//
// Every 1/64 s (one tick):
//   1. read input -> build a usercmd
//   2. PREDICT: run the shared movement code on it right away (no waiting)
//   3. send commands to the server, 2 per message
// When a server snapshot arrives:
//   4. RECONCILE: compare the server's result for the last command it ran
//      with what we predicted. If different, rewind to the server's state
//      and replay the commands it hasn't seen yet.
//   5. INTERPOLATE other players ~100 ms in the past between snapshots.
// Rendering runs as fast as the screen allows and blends between ticks.
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE, PLAYER } from '../shared/constants.js';
import {
  createPlayerState, copyPlayerState, playerMove, spectatorMove, eyeHeight, playerStateError, getHull,
} from '../shared/movement.js';
import { createCmd, copyCmd } from '../shared/usercmd.js';
import {
  MSG, MOVE_SCHEMA, encodeCmds, quantizeCmd, newReader, readSchema, readEntity, EFLAG,
} from '../shared/protocol.js';

export const INTERP_DELAY_MS = 100; // how far in the past other players are drawn
const INTERP_TICKS = (INTERP_DELAY_MS / 1000) * TICK_RATE;
const CMDS_PER_PACKET = 2;
const MAX_HISTORY = 256;

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
    this.history = []; // [{ cmd, state }] commands the server hasn't confirmed
    this.cmdNum = 0;
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
  }

  on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); }
  emit(name, ...args) { for (const fn of this.listeners[name] || []) fn(...args); }

  // ---- connection -------------------------------------------------------------------
  start(name, lobbyToken) {
    this.transport.onmessage = (data) => this.onMessage(data);
    this.transport.onclose = () => this.emit('disconnected');
    this.transport.send(JSON.stringify({ type: 'join', name, token: lobbyToken || undefined }));
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      this.frame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.transport.close();
  }

  onMessage(data) {
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
        this.localId = msg.id;
        this.serverTick = msg.tick;
        this.serverTickEst = msg.tick;
        this.tickEstReady = true;
        for (const p of msg.players) this.roster.set(p.id, p);
        this.emit('welcome', msg);
        break;
      case 'ev':
        for (const ev of msg.list) this.onEvent(ev);
        break;
      case 'error':
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
    const ack = r.u32();
    const flags = r.u8();
    const server = readSchema(r, createPlayerState(), MOVE_SCHEMA);
    this.readPredictedExtra(r);
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
    this.reconcile(ack, server);

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

  // hooks for later stages (weapons, world entities)
  readPredictedExtra(r) { void r; }
  readWorldExtra(r, tick) { void r; void tick; }

  reconcile(ack, server) {
    // Same command acknowledged again and nothing changed: nothing to do.
    if (ack === this.lastAck && this.lastServer && playerStateError(server, this.lastServer) === 0) return;
    this.lastAck = ack;
    this.lastServer = server;
    // forget commands the server has already processed
    while (this.history.length && this.history[0].cmd.num < ack) this.history.shift();
    const entry = this.history.length && this.history[0].cmd.num === ack ? this.history.shift() : null;
    if (entry) {
      const error = playerStateError(entry.state, server);
      this.stats.lastError = error;
      if (error > this.stats.maxError) this.stats.maxError = error;
      if (error < 1e-6) return; // prediction was perfect
    }

    // Rewind to the server's truth and replay everything it hasn't seen yet.
    this.stats.corrections++;
    const before = this.pred.pos.slice();
    const st = createPlayerState();
    copyPlayerState(st, server);
    for (const h of this.history) {
      this.simulate(st, h.cmd, true);
      copyPlayerState(h.state, st);
    }
    copyPlayerState(this.pred, st);
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
  simulate(ps, cmd, replay) {
    if (!this.alive) { spectatorMove(ps, cmd); return null; }
    const ev = playerMove(ps, cmd, {
      world: this.world,
      dt: TICK_DT,
      maxSpeed: this.localMaxSpeed(),
      frozen: this.frozen,
      boxes: this.otherPlayerBoxes(),
    });
    if (!replay) this.onPredictedEvents(ev);
    return ev;
  }

  localMaxSpeed() { return PLAYER.DEFAULT_MAX_SPEED; }

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
    if (!this.localId) return;
    const cmd = createCmd();
    cmd.num = ++this.cmdNum;
    cmd.buttons = this.input.sampleButtons();
    cmd.yaw = this.input.yaw;
    cmd.pitch = this.input.pitch;
    cmd.select = this.input.takeSelect();
    cmd.impulse = this.input.takeImpulse();
    cmd.interp = Math.max(0, this.serverTickEst - INTERP_TICKS);
    quantizeCmd(cmd);
    this.beforeTick(cmd);

    copyPlayerState(this.predPrev, this.pred);
    this.simulate(this.pred, cmd, false);
    this.history.push({ cmd: copyCmd(createCmd(), cmd), state: copyPlayerState(createPlayerState(), this.pred) });
    if (this.history.length > MAX_HISTORY) this.history.shift();

    this.outBatch.push(cmd);
    this.cmdSendTime.set(cmd.num, performance.now());
    if (this.outBatch.length >= CMDS_PER_PACKET) {
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
    const eye = this.eyePosition(alpha);
    this.viewEye = eye;
    const rt = this.renderTick();
    for (const [id, ent] of this.entities) {
      ent.render = this.interpolateEntity(ent, rt);
      this.playersView?.update(id, ent.render, this.roster.get(id), dt);
    }
    this.renderer.setView(eye, this.input.yaw, this.input.pitch);
    this.audio.setListener(eye, this.input.yaw);
    this.beforeRender(alpha, dt);
    this.renderer.render();
    this.hud?.update(this);
  }

  beforeRender(alpha, dt) { void alpha; void dt; }

  updateStats(now, dt) {
    void dt;
    const w = this.statWindow;
    w.frames++;
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
