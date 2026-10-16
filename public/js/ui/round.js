// ---------------------------------------------------------------------------
// round.js — the round HUD: top bar (scores, timer, players alive), big
// centre messages ("Terrorists Win"), plant/defuse progress, the planted
// C4 with its beeping, and the team menu (M).
// ---------------------------------------------------------------------------

import { THREE } from '../render/renderer.js';
import { TEAM } from '../../shared/match.js';
import { EFLAG } from '../../shared/protocol.js';
import { TICK_RATE } from '../../shared/constants.js';

const $ = (id) => document.getElementById(id);

export class RoundHud {
  constructor(input) {
    this.input = input;
    this.game = null;
    this.el = {
      bar: $('round-bar'), ct: $('rb-ct'), t: $('rb-t'), timer: $('rb-timer'), ctAlive: $('rb-ct-alive'), tAlive: $('rb-t-alive'),
      phase: $('rb-phase'), center: $('hud-center-msg'), progress: $('progress'), progressFill: $('progress-fill'), progressText: $('progress-text'),
      teamMenu: $('team-menu'),
    };
    this.state = null;
    input.on('teamMenu', (down) => { if (down && this.game) this.toggleTeamMenu(); });
    this.el.teamMenu.addEventListener('click', (e) => {
      const team = e.target.closest('[data-team]')?.dataset.team;
      if (!team || !this.game) return;
      this.game.transport.send(JSON.stringify({ type: 'team', team }));
      this.toggleTeamMenu(false);
    });
  }

  attach(game, renderer, models) {
    this.game = game;
    this.renderer = renderer;
    this.models = models;
    this.state = null;
    this.bombObj = null;
    this.progress = null;
    this.centerUntil = 0;
    this.el.bar.classList.add('hidden');
    game.on('welcome', (msg) => { if (msg.state && msg.state.round) this.setState(msg.state.round); else this.el.bar.classList.add('hidden'); });
    game.on('scores', (msg) => { if (msg.round) this.setState(msg.round, true); });
    game.on('event', (ev) => this.onEvent(ev));
  }

  setState(st, quiet = false) {
    const g = this.game;
    this.state = { ...st, recvTick: g.serverTickEst };
    this.el.bar.classList.remove('hidden');
    this.el.ct.textContent = st.scoreCT;
    this.el.t.textContent = st.scoreT;
    const phases = { warmup: 'WARMUP', freeze: 'FREEZE TIME', live: '', planted: 'BOMB PLANTED', ended: 'ROUND OVER', matchend: 'MATCH OVER' };
    this.el.phase.textContent = phases[st.phase] ?? '';
    this.el.bar.classList.toggle('planted', st.phase === 'planted');
    this.syncBomb(st.bomb);
    void quiet;
  }

  onEvent(ev) {
    const g = this.game;
    const me = g.localId;
    switch (ev.type) {
      case 'round':
        this.setState(ev);
        if (ev.text) this.center(ev.text, ev.phase === 'ended' || ev.phase === 'matchend' ? 5 : 3, ev.winner);
        if (ev.phase === 'freeze') this.center(`Round ${ev.round}`, 2);
        if (ev.phase === 'live') g.audio.tone({ gain: 0.2, freq: 660, freqEnd: 990, duration: 0.25, type: 'triangle' });
        if (ev.phase === 'ended') this.jingle(ev.winner);
        if (ev.phase === 'planted') {
          this.stopProgress(); // the planter's bar is done
          for (let i = 0; i < 3; i++) g.audio.tone({ gain: 0.2, freq: 880, duration: 0.12, type: 'square', delay: i * 0.18 });
        }
        if (ev.phase === 'ended' || ev.phase === 'freeze') this.stopProgress();
        break;
      case 'notice':
        this.center(ev.text, 2.5);
        break;
      case 'planting':
        if (ev.id === me) this.startProgress('Planting the bomb…', ev.time);
        g.audio.tone({ pos: this.entPos(ev.id), gain: 0.25, freq: 1200, duration: 0.08, type: 'square' });
        break;
      case 'plantAbort':
        if (ev.id === me) this.stopProgress();
        break;
      case 'defusing':
        if (ev.id === me) this.startProgress(ev.kit ? 'Defusing (kit)…' : 'Defusing…', ev.time);
        g.audio.noiseBurst({ pos: this.entPos(ev.id), gain: 0.3, duration: 0.3, filter: 'bandpass', freq: 2200 });
        break;
      case 'defuseAbort':
        if (ev.id === me) this.stopProgress();
        break;
      case 'defused':
        this.stopProgress();
        this.removeBomb();
        g.audio.tone({ gain: 0.25, freq: 520, freqEnd: 260, duration: 0.5, type: 'triangle' });
        break;
      case 'bombExplode':
        this.removeBomb();
        this.stopProgress();
        g.presentation?.nades.boom({ kind: 'he', pos: ev.pos });
        g.presentation?.nades.sprite(ev.pos, 0xffa040, 80, 900, 1.2, true);
        g.audio.tone({ pos: ev.pos, gain: 0.9, freq: 50, freqEnd: 25, duration: 2.0 });
        break;
      case 'spawn':
        if (ev.id === me) this.stopProgress();
        break;
      default:
        break;
    }
  }

  entPos(id) {
    const e = this.game.entities.get(id);
    return e ? e.latest.pos : null;
  }

  center(text, seconds, winner) {
    const el = this.el.center;
    el.textContent = text;
    el.className = winner === TEAM.T ? 't' : winner === TEAM.CT ? 'ct' : '';
    this.centerUntil = performance.now() + seconds * 1000;
  }

  jingle(winner) {
    const a = this.game.audio;
    const notes = winner === TEAM.CT ? [523, 659, 784] : [440, 554, 659];
    notes.forEach((f, i) => a.tone({ gain: 0.18, freq: f, duration: 0.35, type: 'triangle', delay: i * 0.15 }));
  }

  startProgress(text, seconds) {
    this.progress = { start: performance.now(), dur: seconds * 1000 };
    this.el.progressText.textContent = text;
    this.el.progress.classList.remove('hidden');
  }

  stopProgress() {
    this.progress = null;
    this.el.progress.classList.add('hidden');
  }

  syncBomb(bomb) {
    if (!bomb) { this.removeBomb(); return; }
    this.bomb = { ...bomb, recvTick: this.game.serverTickEst };
    if (this.bombObj) return;
    const holder = new THREE.Group();
    holder.position.set(bomb.pos[0], bomb.pos[1], bomb.pos[2] + 2);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    light.position.set(2, 0, 3.5);
    holder.add(light);
    this.renderer.scene.add(holder);
    this.bombObj = holder;
    this.bombLight = light;
    this.nextBeep = 0;
    this.models.load('c4', 'c4').then(() => {
      if (this.bombObj !== holder) return;
      const inst = this.models.instance('c4');
      if (inst) { inst.object.position.z = 1.5; holder.add(inst.object); }
    });
  }

  removeBomb() {
    if (this.bombObj) this.renderer.scene.remove(this.bombObj);
    this.bombObj = null;
    this.bomb = null;
  }

  toggleTeamMenu(force) {
    const show = force ?? this.el.teamMenu.classList.contains('hidden');
    this.el.teamMenu.classList.toggle('hidden', !show);
    if (show) { this.game.menuOpen = true; this.input.unlock(); }
    else { this.input.lock(); setTimeout(() => { if (this.game) this.game.menuOpen = false; }, 300); }
  }

  update() {
    const g = this.game;
    if (!g) return;
    const now = performance.now();
    if (now > this.centerUntil && this.el.center.textContent) this.el.center.textContent = '';
    if (this.state) {
      const elapsed = (g.serverTickEst - this.state.recvTick) / TICK_RATE;
      let left = Math.max(0, this.state.timeLeft - elapsed);
      if (this.state.phase === 'planted' && this.bomb) left = Math.max(0, this.bomb.left - (g.serverTickEst - this.bomb.recvTick) / TICK_RATE);
      const show = this.state.phase === 'planted' ? '💣' : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
      if (this.el.timer.textContent !== show) this.el.timer.textContent = show;
      // players alive per team
      let ct = 0, t = 0;
      for (const e of g.entities.values()) {
        const s = e.latest;
        if (!(s.flags & EFLAG.ALIVE) || (s.wflags & 16)) continue;
        if (s.team === TEAM.CT) ct++; else if (s.team === TEAM.T) t++;
      }
      if (g.alive) { if (g.team === TEAM.CT) ct++; else if (g.team === TEAM.T) t++; }
      this.el.ctAlive.textContent = `${ct} alive`;
      this.el.tAlive.textContent = `${t} alive`;
      // bomb beeps faster as it gets closer to exploding
      if (this.bombObj && this.bomb) {
        const bl = Math.max(0, this.bomb.left - (g.serverTickEst - this.bomb.recvTick) / TICK_RATE);
        const interval = Math.max(0.12, Math.min(1, bl / 40));
        if (now / 1000 >= this.nextBeep) {
          g.audio.tone({ pos: this.bomb.pos, gain: 0.35, freq: 2200, duration: 0.07, type: 'square' });
          this.nextBeep = now / 1000 + interval;
          this.bombLight.visible = true;
          setTimeout(() => { if (this.bombLight) this.bombLight.visible = false; }, 90);
        }
      }
    }
    if (this.progress) {
      const k = Math.min(1, (now - this.progress.start) / this.progress.dur);
      this.el.progressFill.style.width = (k * 100).toFixed(1) + '%';
    }
    // warmup: say what we're waiting for (press M to change team)
    if (this.state && this.state.phase === 'warmup' && this.state.waiting && !this.el.center.textContent) {
      this.el.center.textContent = `${this.state.waiting}. Press M to pick a team.`;
      this.el.center.className = 'small';
      this.centerUntil = now + 500;
    }
    // dead: tell the player what's going on
    if (!g.alive && g.localId && !this.el.center.textContent && this.state && this.state.phase !== 'warmup') {
      const target = g.spectating ? g.roster.get(g.spectating) : null;
      this.el.center.textContent = target
        ? `Spectating ${target.name || 'teammate'} — click to switch`
        : 'You are dead — free camera until the next round';
      this.el.center.className = 'small';
      this.centerUntil = now + 500;
    }
  }
}
