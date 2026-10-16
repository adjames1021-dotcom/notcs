// ---------------------------------------------------------------------------
// rules.js — Bomb defusal rounds (CS2 competitive, MR12).
//
//   WARMUP   until both teams have a player: respawn, free buys
//   FREEZE   15 s at round start: can't move, can buy
//   LIVE     1:55 round; buy for the first 20 s inside your buy zone
//   PLANTED  bomb ticking (40 s) — CTs must defuse (10 s, 5 s with a kit)
//   ENDED    7 s showing who won, then the next round
// Halftime after 12 rounds (sides swap, money resets); first to 13 wins.
// ---------------------------------------------------------------------------

import { TICK_RATE, TICK_DT } from './constants.js';
import { IN } from './usercmd.js';
import { ECONOMY, addMoney, inBox } from './economy.js';
import { giveWeapon, SLOT, removeSlot, switchTo } from './weaponLogic.js';
import { computeDamage } from './bullets.js';
import { HITGROUP } from './weapons.js';
import { makeRng, hashSeed } from './random.js';

export const PHASE = { WARMUP: 'warmup', FREEZE: 'freeze', LIVE: 'live', PLANTED: 'planted', ENDED: 'ended', MATCH_END: 'matchend' };

export const RULES = {
  FREEZE_TIME: 15,
  ROUND_TIME: 115, // 1:55
  BUY_TIME: ECONOMY.BUY_TIME,
  BOMB_TIME: 40,
  PLANT_TIME: 3.2, // TODO: verify CS2 plant time
  DEFUSE_TIME: 10,
  DEFUSE_TIME_KIT: 5,
  DEFUSE_RANGE: 64,
  ROUND_END_TIME: 7,
  HALFTIME_ROUND: 12,
  WIN_ROUNDS: 13,
  WARMUP_COUNTDOWN: 5,
  BOMB_DAMAGE: 500,
  BOMB_RADIUS: 1750,
  MATCH_END_TIME: 15,
};

const T = 1, CT = 2;

export class DefusalRules {
  constructor() {
    this.phase = PHASE.WARMUP;
    this.phaseEnd = 0; // tick when the current phase ends
    this.round = 0;
    this.score = { [T]: 0, [CT]: 0 };
    this.lossStreak = { [T]: 0, [CT]: 0 };
    this.bomb = null; // { pos, planter, explodeTick, defuser, defuseEnd }
    this.roundStartTick = 0;
    this.warmupStart = 0;
  }

  attach(m) {
    this.m = m;
    m.roundsPlayed = 0;
  }

  // ---- hooks used by Match ------------------------------------------------------------
  startMoney() { return this.phase === PHASE.WARMUP ? ECONOMY.MAX_MONEY : ECONOMY.START_MONEY; }

  /** Movement is frozen in freeze time and while planting/defusing. */
  isFrozen(p) {
    if (this.phase === PHASE.FREEZE) return true;
    return !!(p.planting || p.defusing);
  }

  /** Shooting is only blocked during freeze time. */
  isWeaponFrozen() {
    return this.phase === PHASE.FREEZE;
  }

  canBuy(p) {
    if (this.phase === PHASE.WARMUP) return true;
    const zone = this.m.map.buyzones && this.m.map.buyzones[this.m.teamName(p)];
    if (!inBox(p.ps.pos, zone)) return false;
    if (this.phase === PHASE.FREEZE) return true;
    if (this.phase === PHASE.LIVE || this.phase === PHASE.PLANTED) {
      return (this.m.tick - this.roundStartTick) * TICK_DT <= RULES.BUY_TIME;
    }
    return false;
  }

  /** New players / team changes only spawn during warmup (or freeze time). */
  canSpawnNow() {
    return this.phase === PHASE.WARMUP || this.phase === PHASE.FREEZE;
  }

  canChangeTeam(p, team) {
    void p; void team;
    return true; // you'll spawn next round if a round is live
  }

  onSpawn(p) {
    if (this.phase === PHASE.WARMUP) p.money = ECONOMY.MAX_MONEY;
  }

  onKill(p, attacker) {
    p.armor = 0;
    p.helmet = false;
    p.defuser = false;
    p.planting = null;
    if (p.defusing) this.stopDefuse();
    if (this.phase === PHASE.WARMUP) p.respawnAt = this.m.tick + TICK_RATE * 2;
    void attacker;
  }

  /** Planting: hold fire (or E) with the C4 out, inside a bombsite. */
  weaponOutput(p, cmd, out) {
    const m = this.m;
    if (p.team === T && out.plant && p.ws.active === SLOT.C4 && (this.phase === PHASE.LIVE)) {
      const site = this.siteAt(p.ps.pos);
      if (site && p.ps.onGround) {
        if (!p.planting) {
          p.planting = { start: m.tick, site };
          m.emit({ type: 'planting', id: p.id, site, time: RULES.PLANT_TIME });
        } else if ((m.tick - p.planting.start) * TICK_DT >= RULES.PLANT_TIME) {
          this.plant(p, site);
        }
        return;
      } else if (!p.planting && cmd.buttons & IN.ATTACK) {
        m.emit({ type: 'notice', text: 'You must be in a bombsite to plant', to: p.id });
      }
    }
    if (p.planting) {
      p.planting = null;
      m.emit({ type: 'plantAbort', id: p.id });
    }
  }

  siteAt(pos) {
    for (const [name, box] of Object.entries(this.m.map.bombsites || {})) if (inBox(pos, box)) return name;
    return null;
  }

  // ---- per tick -----------------------------------------------------------------------
  update() {
    const m = this.m;
    const now = m.tick;
    const teams = this.teamCounts();
    switch (this.phase) {
      case PHASE.WARMUP:
        if (teams[T].total > 0 && teams[CT].total > 0) {
          if (!this.warmupStart) {
            this.warmupStart = now;
            m.emit({ type: 'round', phase: 'warmup', text: `Match starting in ${RULES.WARMUP_COUNTDOWN} s`, ...this.publicRoundState() });
          }
          if (now - this.warmupStart >= RULES.WARMUP_COUNTDOWN * TICK_RATE) this.startMatch();
        } else this.warmupStart = 0;
        break;
      case PHASE.FREEZE:
        if (now >= this.phaseEnd) {
          this.phase = PHASE.LIVE;
          this.roundStartTick = now;
          this.phaseEnd = now + RULES.ROUND_TIME * TICK_RATE;
          m.emit({ type: 'round', phase: 'live', ...this.publicRoundState() });
        }
        break;
      case PHASE.LIVE:
        this.checkElimination(teams);
        if (this.phase === PHASE.LIVE && now >= this.phaseEnd) this.endRound(CT, 'time');
        break;
      case PHASE.PLANTED:
        this.updateDefuse();
        if (this.phase !== PHASE.PLANTED) break;
        if (now >= this.bomb.explodeTick) { this.explode(); break; }
        if (teams[CT].alive === 0) this.endRound(T, 'elimination');
        break;
      case PHASE.ENDED:
        if (now >= this.phaseEnd) this.nextRound();
        break;
      case PHASE.MATCH_END:
        if (now >= this.phaseEnd) this.resetMatch();
        break;
      default:
        break;
    }
  }

  teamCounts() {
    const c = { [T]: { total: 0, alive: 0 }, [CT]: { total: 0, alive: 0 } };
    for (const p of this.m.players.values()) {
      if (p.dummy || (p.team !== T && p.team !== CT)) continue;
      if (!p.connected && !p.alive) continue;
      c[p.team].total++;
      if (p.alive) c[p.team].alive++;
    }
    return c;
  }

  checkElimination(teams) {
    if (teams[T].alive === 0 && teams[T].total > 0) this.endRound(CT, 'elimination');
    else if (teams[CT].alive === 0 && teams[CT].total > 0) this.endRound(T, 'elimination');
  }

  // ---- rounds -------------------------------------------------------------------------
  startMatch() {
    const m = this.m;
    this.round = 0;
    this.score = { [T]: 0, [CT]: 0 };
    this.lossStreak = { [T]: 0, [CT]: 0 };
    m.roundsPlayed = 0;
    for (const p of m.players.values()) {
      p.money = ECONOMY.START_MONEY;
      p.stats = { kills: 0, deaths: 0, assists: 0, damage: 0, score: 0, mvps: 0, hs: 0 };
      p.armor = 0; p.helmet = false; p.defuser = false;
      p.alive = false; // everyone gets a fresh default loadout
    }
    m.emit({ type: 'round', phase: 'matchstart', text: 'Match started — good luck!', ...this.publicRoundState() });
    this.startRound();
  }

  startRound() {
    const m = this.m;
    this.round++;
    this.bomb = null;
    m.items.clear();
    m.grenades.clear();
    this.phase = PHASE.FREEZE;
    this.phaseEnd = m.tick + RULES.FREEZE_TIME * TICK_RATE;
    this.roundStartTick = this.phaseEnd;
    m.spawnCursor = { 1: 0, 2: 0 };
    for (const p of m.players.values()) {
      if (p.dummy || (p.team !== T && p.team !== CT)) continue;
      if (!p.connected) { p.alive = false; continue; }
      p.planting = null; p.defusing = false;
      // survivors keep their gear; the dead get the default pistol + knife
      m.spawnPlayer(p, { keepLoadout: p.alive });
      if (p.ws.c4) removeSlot(p.ws, SLOT.C4);
    }
    // one random terrorist carries the bomb
    const ts = [...m.players.values()].filter((p) => p.team === T && p.alive);
    if (ts.length) {
      const rng = makeRng(hashSeed(this.round, m.tick));
      const carrier = ts[Math.floor(rng() * ts.length)];
      giveWeapon(carrier.ws, 'c4');
      m.emit({ type: 'notice', text: 'You have the bomb — plant it at A or B', to: carrier.id });
    }
    m.emit({ type: 'round', phase: 'freeze', ...this.publicRoundState() });
  }

  endRound(winner, reason) {
    const m = this.m;
    if (this.phase === PHASE.ENDED || this.phase === PHASE.MATCH_END) return;
    const loser = winner === T ? CT : T;
    this.score[winner]++;
    m.roundsPlayed++;
    // CS2 money
    const winMoney = reason === 'bomb' ? ECONOMY.WIN_BOMB_EXPLODED : reason === 'defuse' ? ECONOMY.WIN_BOMB_DEFUSED
      : reason === 'time' ? ECONOMY.WIN_TIME : ECONOMY.WIN_ELIMINATION;
    const lossIdx = Math.min(this.lossStreak[loser], ECONOMY.LOSS_BONUS.length - 1);
    const lossMoney = ECONOMY.LOSS_BONUS[lossIdx];
    this.lossStreak[loser] = Math.min(this.lossStreak[loser] + 1, ECONOMY.LOSS_BONUS.length - 1);
    this.lossStreak[winner] = Math.max(0, this.lossStreak[winner] - 1); // CS2: wins reduce the loss bonus by one step
    for (const p of m.players.values()) {
      if (p.dummy) continue;
      if (p.team === winner) addMoney(p, winMoney);
      else if (p.team === loser) {
        let amt = lossMoney;
        // Ts who survive a round lost on time get nothing (CS rule)
        if (loser === T && reason === 'time' && p.alive) amt = 0;
        if (loser === T && this.bomb) amt += ECONOMY.LOSS_PLANTED_BONUS;
        addMoney(p, amt);
      }
    }
    this.phase = PHASE.ENDED;
    this.phaseEnd = m.tick + RULES.ROUND_END_TIME * TICK_RATE;
    const text = `${winner === T ? 'Terrorists' : 'Counter-Terrorists'} Win`;
    m.emit({ type: 'round', phase: 'ended', winner, reason, text, winMoney, lossMoney, ...this.publicRoundState() });
    if (this.score[winner] >= RULES.WIN_ROUNDS || (this.score[T] === RULES.HALFTIME_ROUND && this.score[CT] === RULES.HALFTIME_ROUND)) {
      this.phase = PHASE.MATCH_END;
      this.phaseEnd = m.tick + RULES.MATCH_END_TIME * TICK_RATE;
      const draw = this.score[T] === this.score[CT];
      m.emit({ type: 'round', phase: 'matchend', winner: draw ? 0 : winner, text: draw ? 'Match drawn' : `${text} the match!`, ...this.publicRoundState() });
    }
  }

  nextRound() {
    const m = this.m;
    if (m.roundsPlayed === RULES.HALFTIME_ROUND) {
      // halftime: swap sides, reset money and loss bonuses
      for (const p of m.players.values()) {
        if (p.dummy) continue;
        if (p.team === T) p.team = CT; else if (p.team === CT) p.team = T;
        p.money = ECONOMY.START_MONEY;
        p.alive = false; p.armor = 0; p.helmet = false; p.defuser = false;
        m.emit({ type: 'team', id: p.id, team: p.team });
      }
      this.score = { [T]: this.score[CT], [CT]: this.score[T] };
      this.lossStreak = { [T]: 0, [CT]: 0 };
      m.emit({ type: 'round', phase: 'halftime', text: 'Halftime — switching sides', ...this.publicRoundState() });
    }
    this.startRound();
  }

  resetMatch() {
    this.phase = PHASE.WARMUP;
    this.warmupStart = 0;
    this.round = 0;
    this.score = { [T]: 0, [CT]: 0 };
    for (const p of this.m.players.values()) {
      p.money = ECONOMY.MAX_MONEY;
      if (!p.alive && (p.team === T || p.team === CT) && p.connected) this.m.spawnPlayer(p);
    }
    this.m.emit({ type: 'round', phase: 'warmup', text: 'Warmup', ...this.publicRoundState() });
  }

  // ---- the bomb ----------------------------------------------------------------------------
  plant(p, site) {
    const m = this.m;
    p.planting = null;
    removeSlot(p.ws, SLOT.C4);
    const next = p.ws.last && p.ws.last !== SLOT.C4 ? p.ws.last : SLOT.SECONDARY;
    p.ws.active = SLOT.NONE;
    switchTo(p.ws, p.ws.pri ? SLOT.PRIMARY : next);
    this.bomb = { pos: p.ps.pos.slice(), site, planter: p.id, explodeTick: m.tick + RULES.BOMB_TIME * TICK_RATE, defuser: 0, defuseEnd: 0 };
    this.phase = PHASE.PLANTED;
    addMoney(p, ECONOMY.PLANT_REWARD);
    p.stats.score += 2;
    m.emit({ type: 'money', amount: ECONOMY.PLANT_REWARD, reason: 'Planted the bomb', to: p.id });
    m.emit({ type: 'round', phase: 'planted', text: 'The bomb has been planted', planter: p.id, ...this.publicRoundState() });
  }

  updateDefuse() {
    const m = this.m;
    const b = this.bomb;
    if (b.defuser) {
      const d = m.players.get(b.defuser);
      if (!d || !d.alive || !(d.lastButtons & IN.USE) || !this.nearBomb(d)) { this.stopDefuse(); return; }
      if (m.tick >= b.defuseEnd) this.defused(d);
      return;
    }
    for (const p of m.players.values()) {
      if (p.team !== CT || !p.alive || !(p.lastButtons & IN.USE) || !this.nearBomb(p)) continue;
      const time = p.defuser ? RULES.DEFUSE_TIME_KIT : RULES.DEFUSE_TIME;
      b.defuser = p.id;
      b.defuseEnd = m.tick + Math.round(time * TICK_RATE);
      p.defusing = true;
      m.emit({ type: 'defusing', id: p.id, time, kit: !!p.defuser });
      break;
    }
  }

  nearBomb(p) {
    const b = this.bomb;
    const dx = p.ps.pos[0] - b.pos[0], dy = p.ps.pos[1] - b.pos[1], dz = p.ps.pos[2] - b.pos[2];
    return Math.hypot(dx, dy) < RULES.DEFUSE_RANGE && Math.abs(dz) < 72;
  }

  stopDefuse() {
    const b = this.bomb;
    if (!b || !b.defuser) return;
    const d = this.m.players.get(b.defuser);
    if (d) d.defusing = false;
    this.m.emit({ type: 'defuseAbort', id: b.defuser });
    b.defuser = 0;
    b.defuseEnd = 0;
  }

  defused(p) {
    const m = this.m;
    p.defusing = false;
    addMoney(p, ECONOMY.DEFUSE_REWARD);
    p.stats.score += 2;
    m.emit({ type: 'money', amount: ECONOMY.DEFUSE_REWARD, reason: 'Defused the bomb', to: p.id });
    m.emit({ type: 'defused', id: p.id, pos: this.bomb.pos });
    this.bomb.defused = true;
    this.endRound(CT, 'defuse');
  }

  explode() {
    const m = this.m;
    const b = this.bomb;
    const c = [b.pos[0], b.pos[1], b.pos[2] + 16];
    m.emit({ type: 'bombExplode', pos: c });
    for (const v of m.players.values()) {
      if (!v.alive) continue;
      const d = Math.hypot(v.ps.pos[0] - c[0], v.ps.pos[1] - c[1], v.ps.pos[2] + 36 - c[2]);
      if (d > RULES.BOMB_RADIUS) continue;
      const f = d / RULES.BOMB_RADIUS;
      const raw = RULES.BOMB_DAMAGE * Math.exp(-f * f * 4.5);
      const dmg = computeDamage(raw, HITGROUP.GENERIC, 50, v);
      m.damagePlayer(v, dmg.health, dmg.armor, null, 'c4', { group: HITGROUP.GENERIC, from: c });
    }
    this.bomb.exploded = true;
    this.endRound(T, 'bomb');
  }

  // ---- network ------------------------------------------------------------------------------
  publicRoundState() {
    const m = this.m;
    return {
      phase: this.phase,
      round: this.round,
      scoreT: this.score[T],
      scoreCT: this.score[CT],
      timeLeft: Math.max(0, (this.phaseEnd - m.tick) * TICK_DT),
      buyLeft: this.phase === PHASE.FREEZE ? RULES.FREEZE_TIME + RULES.BUY_TIME
        : Math.max(0, RULES.BUY_TIME - (m.tick - this.roundStartTick) * TICK_DT),
      bomb: this.bomb ? { pos: this.bomb.pos.map((v) => Math.round(v * 10) / 10), site: this.bomb.site, left: Math.max(0, (this.bomb.explodeTick - m.tick) * TICK_DT), defuser: this.bomb.defuser } : null,
      serverTick: m.tick,
    };
  }

  publicRound() { return { round: this.publicRoundState() }; }
}
