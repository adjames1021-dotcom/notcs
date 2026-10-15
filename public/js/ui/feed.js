// ---------------------------------------------------------------------------
// feed.js — kill feed (top right), chat (bottom left), money pop-ups and
// the scoreboard (hold Tab).
// ---------------------------------------------------------------------------

import { WEAPONS } from '../../shared/weapons.js';
import { TEAM } from '../../shared/match.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Feed {
  // Created once; attach() points it at the current game.
  constructor(input) {
    this.game = null;
    this.input = input;
    this.killEl = $('killfeed');
    this.chatEl = $('chat-log');
    this.chatInput = $('chat-input');
    this.moneyEl = $('hud-money-delta');
    this.scoreEl = $('scoreboard');
    this.scores = [];
    this.chatting = false;
    this.teamChat = false;
    input.on('score', (down) => { if (!this.game) return; this.scoreVisible = down; this.scoreEl.classList.toggle('hidden', !down); if (down) this.renderScores(); });
    input.on('chat', (down, e) => { if (down && !this.chatting && this.game) { e.preventDefault(); this.openChat(false); } });
    input.on('teamChat', (down, e) => { if (down && !this.chatting && this.game) { e.preventDefault(); this.openChat(true); } });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        if (text && this.game) this.game.transport.send(JSON.stringify({ type: 'chat', text, teamOnly: this.teamChat }));
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
  }

  attach(game) {
    this.game = game;
    this.killEl.innerHTML = '';
    this.chatEl.innerHTML = '';
    this.scores = [];
    game.on('event', (ev) => this.onEvent(ev));
    game.on('scores', (msg) => { this.scores = msg.players; this.round = msg.round || null; if (this.scoreVisible) this.renderScores(); });
  }

  name(id) {
    const r = this.game.roster.get(id);
    return r ? r.name : id === this.game.localId ? 'You' : '?';
  }

  teamClass(id) {
    const r = this.game.roster.get(id);
    const team = id === this.game.localId ? this.game.team : r ? r.team : 0;
    return team === TEAM.CT ? 'ct' : team === TEAM.T ? 't' : '';
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'kill': this.addKill(ev); break;
      case 'chat': this.addChat(ev); break;
      case 'money': this.moneyPop(ev.amount, ev.reason); break;
      case 'join': this.addSystem(`${ev.name} joined`); break;
      case 'leave': this.addSystem(`${this.name(ev.id)} left`); break;
      case 'disconnect': this.addSystem(`${this.name(ev.id)} disconnected`); break;
      case 'reconnect': this.addSystem(`${this.name(ev.id)} reconnected`); break;
      default: break;
    }
  }

  addKill(ev) {
    const row = document.createElement('div');
    const mine = ev.attacker === this.game.localId || ev.victim === this.game.localId;
    row.className = 'kill-row' + (mine ? ' mine' : '');
    const weapon = WEAPONS[ev.weapon] ? WEAPONS[ev.weapon].name : ev.weapon === 'fall' ? 'fell' : ev.weapon || 'died';
    const attacker = ev.attacker && ev.attacker !== ev.victim ? `<span class="${this.teamClass(ev.attacker)}">${esc(this.name(ev.attacker))}</span>` : '';
    const assist = ev.assister ? ` + <span class="${this.teamClass(ev.assister)}">${esc(this.name(ev.assister))}</span>` : '';
    const tags = (ev.headshot ? ' <span class="tag">HS</span>' : '') + (ev.wallbang ? ' <span class="tag">WB</span>' : '');
    row.innerHTML = `${attacker}${assist}<span class="weapon">[${esc(weapon)}]${tags}</span><span class="${this.teamClass(ev.victim)}">${esc(this.name(ev.victim))}</span>`;
    this.killEl.appendChild(row);
    while (this.killEl.children.length > 6) this.killEl.firstChild.remove();
    setTimeout(() => row.remove(), 7000);
  }

  addChat(ev) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = `${ev.teamOnly ? '<span class="tag">(team)</span> ' : ''}<span class="${this.teamClass(ev.id)}">${esc(this.name(ev.id))}</span>: ${esc(ev.text)}`;
    this.chatEl.appendChild(row);
    while (this.chatEl.children.length > 8) this.chatEl.firstChild.remove();
    setTimeout(() => row.classList.add('old'), 9000);
  }

  addSystem(text) {
    const row = document.createElement('div');
    row.className = 'chat-row system';
    row.textContent = text;
    this.chatEl.appendChild(row);
    setTimeout(() => row.classList.add('old'), 6000);
  }

  openChat(team) {
    this.chatting = true;
    this.teamChat = team;
    this.input.enabled = false;
    this.chatInput.placeholder = team ? 'Team chat — Enter to send' : 'Chat — Enter to send';
    this.chatInput.classList.remove('hidden');
    this.chatInput.value = '';
    setTimeout(() => this.chatInput.focus(), 0);
  }

  closeChat() {
    this.chatting = false;
    this.input.enabled = true;
    this.chatInput.blur();
    this.chatInput.classList.add('hidden');
  }

  moneyPop(amount, reason) {
    if (!this.moneyEl) return;
    this.moneyEl.textContent = `${amount >= 0 ? '+' : '-'}$${Math.abs(amount)}  ${reason || ''}`;
    this.moneyEl.className = amount >= 0 ? 'show plus' : 'show minus';
    clearTimeout(this._mt);
    this._mt = setTimeout(() => { this.moneyEl.className = ''; }, 2500);
  }

  renderScores() {
    const g = this.game;
    const rows = { [TEAM.CT]: [], [TEAM.T]: [], [TEAM.SPEC]: [] };
    for (const p of this.scores) (rows[p.team] || rows[TEAM.SPEC]).push(p);
    const section = (team, title, cls) => {
      const list = rows[team].sort((a, b) => b.score - a.score || b.kills - a.kills);
      const score = this.round ? (team === TEAM.CT ? this.round.ct : team === TEAM.T ? this.round.t : '') : '';
      const body = list.map((p) => `<tr class="${p.id === g.localId ? 'me' : ''}${p.alive ? '' : ' dead'}">
        <td class="nm">${esc(p.name)}${p.bot ? ' <span class="tag">BOT</span>' : ''}${p.connected ? '' : ' <span class="tag">offline</span>'}</td>
        <td>${p.money ?? ''}</td><td>${p.kills}</td><td>${p.assists}</td><td>${p.deaths}</td><td>${p.adr ?? 0}</td><td>${p.score}</td><td>${p.ping ?? ''}</td></tr>`).join('');
      return `<div class="sb-team ${cls}"><div class="sb-title"><span>${title}</span><span class="sb-score">${score}</span></div>
        <table><thead><tr><th class="nm">Player</th><th>$</th><th>K</th><th>A</th><th>D</th><th>ADR</th><th>Score</th><th>Ping</th></tr></thead><tbody>${body}</tbody></table></div>`;
    };
    const spec = rows[TEAM.SPEC].length ? `<div class="sb-spec">Spectators: ${rows[TEAM.SPEC].map((p) => esc(p.name)).join(', ')}</div>` : '';
    const roundInfo = this.round ? `<div class="sb-round">Round ${this.round.number} · first to ${this.round.winScore}</div>` : '';
    this.scoreEl.innerHTML = `<div class="sb-panel">${roundInfo}${section(TEAM.CT, 'Counter-Terrorists', 'ct')}${section(TEAM.T, 'Terrorists', 't')}${spec}
      <div class="sb-foot">notcs · free fan project · never for sale · not affiliated with Valve</div></div>`;
  }
}
