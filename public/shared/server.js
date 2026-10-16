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
// No input for this long (e.g. the game tab is in the background, so the
// browser stops running it) = disconnected, so a forgotten tab doesn't keep a
// lobby running (and billing) all day. The client rejoins when you come back.
const IDLE_KICK_SECONDS = 60;
export const CLOSE_IDLE = 4001;

export class MatchServer {
  /**
   * @param timerSlackMs  0 = tick on a timer (Practice). Online, ticks run when
   *   input arrives and the timer only fires if no input came for this long.
   */
  constructor({
    world, map, mode = 'defusal', now = () => Date.now(), log = () => {}, options = {}, timerSlackMs = 0, cmdsPerMessage = 2,
  }) {
    this.match = new Match({ world, map, mode, log, options });
    this.sessions = new Set();
    this.now = now;
    this.log = log;
    this.running = false;
    this.timer = null;
    this.tickMs = 1000 / TICK_RATE;
    this.nextTime = 0;
    this.timerSlackMs = timerSlackMs;
    this.cmdsPerMessage = Math.max(1, Math.min(8, Math.round(cmdsPerMessage)));
    this.idleKick = mode !== 'practice';
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
    if (type === MSG.CMDS) {
      this.match.queueCmds(p, decodeCmds(r));
      if (this.timerSlackMs > 0) this.runDue(); // tick now if one is due (see timerSlackMs)
    }
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
        this.log(`player ${p.id} reconnected`);
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
        // a rejoining client continues numbering its commands from here, so
        // the server doesn't throw away its input as "old" (and weapon timers,
        // which count in commands, carry on)
        cmdBase: p.lastCmdNum,
        cmdsPerMessage: this.cmdsPerMessage,
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
      case 'refund':
        if (m.refund && typeof msg.item === 'string') m.refund(p, msg.item);
        break;
      case 'chat': {
        if (session.chatTokens < 1) break;
        session.chatTokens -= 1;
        const text = String(msg.text || '').slice(0, 120);
        if (text.trim()) m.emit({ type: 'chat', id: p.id, text, teamOnly: !!msg.teamOnly });
        break;
      }
      case 'ping':
        if (Number.isFinite(msg.ping)) p.ping = Math.max(0, Math.min(999, Math.round(msg.ping)));
        if (msg.t !== undefined) this.send(session, JSON.stringify({ type: 'pong', t: msg.t }));
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
    const delay = Math.max(0, this.nextTime - this.now()) + this.timerSlackMs;
    this.timer = setTimeout(() => this.loop(), delay);
  }

  loop() {
    this.timer = null;
    if (!this.running) return;
    this.runDue();
    this.schedule();
  }

  /** Run every tick that is due by the clock (called by the timer and on input). */
  runDue() {
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
  }

  /** Disconnect players whose game has sent nothing for IDLE_KICK_SECONDS. */
  kickIdle() {
    const m = this.match;
    for (const s of this.sessions) {
      const p = s.player;
      if (!p || m.tick - (p.lastInputTick ?? m.tick) < IDLE_KICK_SECONDS * TICK_RATE) continue;
      this.log(`player ${p.id} idle for ${IDLE_KICK_SECONDS} s, disconnecting`);
      this.send(s, JSON.stringify({ type: 'kicked', reason: 'idle' }));
      try { s.conn.close(CLOSE_IDLE, 'idle'); } catch { /* ignore */ }
      this.handleClose(s);
    }
  }

  /** One server tick: simulate, then send each client its snapshot. */
  step() {
    const m = this.match;
    m.step();
    for (const s of this.sessions) {
      if (s.chatTokens < 5) s.chatTokens = Math.min(5, s.chatTokens + 1 / (TICK_RATE * 2));
    }
    if (this.idleKick && m.tick % TICK_RATE === 0) this.kickIdle();
    const events = m.takeEvents();
    const sendScores = m.tick % 32 === 0;
    const states = new Map();
    for (const p of m.players.values()) states.set(p.id, m.entityState(p));
    for (const s of this.sessions) {
      if (!s.player) continue;
      this.send(s, this.buildSnapshot(s.player, states));
      const mine = events.filter((e) => (e.to === undefined || e.to === s.player.id) && e.except !== s.player.id &&
        (!e.teamOnly || this.sameTeam(e, s.player)));
      if (mine.length) this.send(s, JSON.stringify({ type: 'ev', tick: m.tick, list: mine }));
      if (sendScores) this.send(s, JSON.stringify({ type: 'scores', players: m.scoreboard(s.player), round: m.roundInfo ? m.roundInfo() : null }));
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
    if (m.isWeaponFrozen(p)) flags |= 4;
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
