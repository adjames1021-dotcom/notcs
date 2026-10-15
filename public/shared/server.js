// ---------------------------------------------------------------------------
// server.js — wraps a Match with networking: accepts connections, decodes
// input, runs the fixed 64-tick loop, and sends every client a snapshot each
// tick. Used by the Durable Object (online) and by Practice mode (offline).
//
// A "connection" is anything with send(stringOrArrayBuffer) and close().
// ---------------------------------------------------------------------------

import { Match, TEAM } from './match.js';
import {
  MSG, MOVE_SCHEMA, ENT, ByteWriter, newReader, decodeCmds, writeSchema, entityDelta, writeEntity,
} from './protocol.js';
import { TICK_RATE } from './constants.js';

const MAX_TICKS_PER_LOOP = 5;

export class MatchServer {
  constructor({ world, map, mode = 'defusal', now = () => Date.now(), log = () => {}, options = {} }) {
    this.match = new Match({ world, map, mode, log, options });
    this.sessions = new Set();
    this.now = now;
    this.log = log;
    this.running = false;
    this.timer = null;
    this.tickMs = 1000 / TICK_RATE;
    this.nextTime = 0;
    this.onEmpty = null; // called when the last player leaves
  }

  // ---- connections --------------------------------------------------------------------
  connect(conn) {
    const session = { conn, player: null, chatTokens: 5, closed: false };
    this.sessions.add(session);
    return {
      onMessage: (data) => this.handleMessage(session, data),
      onClose: () => this.handleClose(session),
    };
  }

  handleClose(session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session);
    if (session.player) this.match.disconnect(session.player);
    if (this.match.connectedCount() === 0) {
      this.stop();
      if (this.onEmpty) this.onEmpty();
    }
  }

  send(session, data) {
    if (session.closed) return;
    try {
      session.conn.send(data);
    } catch {
      this.handleClose(session);
    }
  }

  handleMessage(session, data) {
    try {
      if (typeof data === 'string') this.handleText(session, JSON.parse(data));
      else this.handleBinary(session, data);
    } catch (err) {
      this.log('bad message: ' + (err && err.message));
    }
  }

  handleBinary(session, data) {
    const p = session.player;
    if (!p) return;
    const ab = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const r = newReader(ab);
    const type = r.u8();
    if (type === MSG.CMDS) this.match.queueCmds(p, decodeCmds(r));
  }

  handleText(session, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const m = this.match;
    if (msg.type === 'join') {
      if (session.player) return;
      let p = null;
      if (typeof msg.token === 'string' && msg.token.length >= 8) {
        for (const q of m.players.values()) if (q.token === msg.token) p = q;
      }
      if (p) {
        // A reconnect: kick any older socket still attached to this player.
        for (const s of this.sessions) if (s !== session && s.player === p) { s.player = null; try { s.conn.close(); } catch { /* ignore */ } }
        m.reconnect(p);
      } else {
        const team = msg.team === 'T' ? TEAM.T : msg.team === 'CT' ? TEAM.CT : msg.team === 'SPEC' ? TEAM.SPEC : 0;
        const token = typeof msg.token === 'string' && msg.token.length >= 8 ? msg.token.slice(0, 64) : randomToken();
        p = m.addPlayer({ name: msg.name, team, token });
        if (!p) {
          this.send(session, JSON.stringify({ type: 'error', message: 'Match is full' }));
          try { session.conn.close(); } catch { /* ignore */ }
          return;
        }
      }
      session.player = p;
      this.send(session, JSON.stringify({
        type: 'welcome',
        id: p.id,
        token: p.token,
        tick: m.tick,
        tickRate: TICK_RATE,
        mode: m.mode,
        map: m.map.name,
        players: m.publicInfo(),
        state: m.publicState ? m.publicState() : null,
      }));
      this.start();
      return;
    }
    const p = session.player;
    if (!p) return;
    switch (msg.type) {
      case 'team': {
        const team = msg.team === 'T' ? TEAM.T : msg.team === 'CT' ? TEAM.CT : msg.team === 'SPEC' ? TEAM.SPEC : 0;
        if (team) m.requestTeam ? m.requestTeam(p, team) : m.setTeam(p, team);
        break;
      }
      case 'buy':
        if (m.buy && typeof msg.item === 'string') m.buy(p, msg.item);
        break;
      case 'chat': {
        if (session.chatTokens < 1) break;
        session.chatTokens -= 1;
        const text = String(msg.text || '').slice(0, 120);
        if (text.trim()) m.emit({ type: 'chat', id: p.id, text, teamOnly: !!msg.teamOnly });
        break;
      }
      case 'ping':
        this.send(session, JSON.stringify({ type: 'pong', t: msg.t }));
        break;
      default:
        if (m.handleAction) m.handleAction(p, msg);
    }
  }

  // ---- the tick loop --------------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this.nextTime = this.now();
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTime - this.now());
    this.timer = setTimeout(() => this.loop(), delay);
  }

  loop() {
    this.timer = null;
    if (!this.running) return;
    const now = this.now();
    let n = 0;
    while (now >= this.nextTime && n < MAX_TICKS_PER_LOOP) {
      this.step();
      this.nextTime += this.tickMs;
      n++;
    }
    if (now - this.nextTime > 250) {
      // hopelessly behind: skip ahead, but let clients catch up their input
      this.match.grantTicks(Math.floor((now - this.nextTime) / this.tickMs));
      this.nextTime = now;
    }
    this.schedule();
  }

  /** One server tick: simulate, then send each client its snapshot. */
  step() {
    const m = this.match;
    m.step();
    for (const s of this.sessions) {
      if (s.chatTokens < 5) s.chatTokens = Math.min(5, s.chatTokens + 1 / (TICK_RATE * 2));
    }
    const events = m.takeEvents();
    const states = new Map();
    for (const p of m.players.values()) states.set(p.id, m.entityState(p));
    for (const s of this.sessions) {
      if (!s.player) continue;
      this.send(s, this.buildSnapshot(s.player, states));
      const mine = events.filter((e) => (e.to === undefined || e.to === s.player.id) && e.except !== s.player.id &&
        (!e.teamOnly || this.sameTeam(e, s.player)));
      if (mine.length) this.send(s, JSON.stringify({ type: 'ev', tick: m.tick, list: mine }));
    }
  }

  sameTeam(ev, p) {
    const from = this.match.players.get(ev.id);
    return from && from.team === p.team;
  }

  buildSnapshot(p, states) {
    const m = this.match;
    const w = new ByteWriter(512);
    w.u8(MSG.SNAPSHOT).u32(m.tick).u32(p.lastCmdNum);
    let flags = 0;
    if (p.alive) flags |= 1;
    if (m.isFrozen(p)) flags |= 2;
    w.u8(flags);
    writeSchema(w, p.ps, MOVE_SCHEMA);
    if (m.writePredicted) m.writePredicted(w, p);
    // HUD
    w.u8(Math.max(0, Math.min(255, Math.ceil(p.health))));
    w.u8(Math.max(0, Math.min(255, Math.ceil(p.armor))));
    w.u8((p.helmet ? 1 : 0) | (p.defuser ? 2 : 0));
    w.u32(Math.max(0, Math.floor(p.money)));
    w.u8(p.team);
    // Other players, delta-compressed against what we last sent this client.
    const countPos = w.o;
    w.u16(0);
    let count = 0;
    for (const [id, st] of states) {
      if (id === p.id) continue;
      const mask = entityDelta(p.netCache.get(id), st);
      if (!mask) continue;
      writeEntity(w, st, mask);
      p.netCache.set(id, st);
      count++;
    }
    for (const id of [...p.netCache.keys()]) {
      if (!states.has(id)) {
        writeEntity(w, { id }, ENT.REMOVED);
        p.netCache.delete(id);
        count++;
      }
    }
    w.setU16At(countPos, count);
    if (m.writeWorld) m.writeWorld(w, p);
    return w.finish();
  }
}

export function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
