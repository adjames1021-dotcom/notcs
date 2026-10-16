// ---------------------------------------------------------------------------
// mainmenu.js — the CS2-style main menu.
//
//   PLAY      pick a game mode, press GO. Online modes join the busiest open
//             lobby of that mode, or start a new one that others will find.
//   LOBBIES   the lobby finder: every open lobby (they're all public), join
//             any of them, or create/join one by name.
// Settings and Controls open the existing screens (ui/menus.js).
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

export const MODES = {
  comp: {
    name: 'Competitive', server: 'defusal',
    desc: 'Bomb defusal, 5 against 5. Terrorists plant the bomb at A or B, Counter-Terrorists stop them. CS2 money, first to 13 rounds, sides swap after 12.',
  },
  casual: {
    name: 'Casual', server: 'casual',
    desc: 'Relaxed bomb defusal for up to 20 players. Everyone gets armor (and CTs a defuse kit) for free, buying lasts longer, first to 8 rounds.',
  },
  dm: {
    name: 'Deathmatch', server: 'deathmatch',
    desc: 'Everyone against everyone. Respawn after 2 seconds and buy any gun for free, anywhere. Great for warming up your aim.',
  },
  practice: {
    name: 'Practice', server: 'practice',
    desc: 'Just you, offline: target dummies, every weapon and grenade for free, and a fake-lag setting (in Settings) to try the netcode.',
  },
};
const SERVER_NAMES = { defusal: 'Competitive', casual: 'Casual', deathmatch: 'Deathmatch' };
const REFRESH_MS = 8000;

export class MainMenu {
  /** @param onPlay ({ online, code, mode }) => void */
  constructor({ onPlay, status }) {
    this.onPlay = onPlay;
    this.status = status;
    this.mode = 'comp';
    this.lobbies = [];
    this.timer = null;
    this.busy = false;
    for (const b of document.querySelectorAll('.mm-tab[data-tab]')) b.addEventListener('click', () => this.tab(b.dataset.tab));
    for (const b of document.querySelectorAll('.mm-mode')) b.addEventListener('click', () => this.pickMode(b.dataset.mode));
    for (const b of document.querySelectorAll('.mm-mode')) b.addEventListener('dblclick', () => { this.pickMode(b.dataset.mode); this.go(); });
    $('btn-go').addEventListener('click', () => this.go());
    $('btn-refresh').addEventListener('click', () => this.refresh());
    $('lobby-filter').addEventListener('change', () => this.render());
    $('btn-online').addEventListener('click', () => this.joinTyped());
    $('menu-lobby').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinTyped(); });
    $('lobby-rows').addEventListener('click', (e) => {
      const code = e.target.closest('[data-join]')?.dataset.join;
      if (code) this.join(code);
    });
    document.addEventListener('visibilitychange', () => this.schedule());
    this.pickMode('comp');
    // a shared link like ?lobby=friends123 opens the lobby finder with it filled in
    try {
      const code = new URLSearchParams(location.search).get('lobby');
      if (code) { $('menu-lobby').value = clean(code); this.tab('lobbies'); }
    } catch { /* ignore */ }
  }

  get visible() { return !$('menu').classList.contains('hidden'); }

  show() {
    $('menu').classList.remove('hidden');
    this.busy = false;
    $('btn-go').disabled = false;
    this.schedule();
  }

  hide() {
    $('menu').classList.add('hidden');
    this.schedule();
  }

  tab(name) {
    for (const b of document.querySelectorAll('.mm-tab[data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
    $('page-play').classList.toggle('hidden', name !== 'play');
    $('page-lobbies').classList.toggle('hidden', name !== 'lobbies');
    this.current = name;
    if (name === 'lobbies') this.refresh();
    this.schedule();
  }

  pickMode(mode) {
    this.mode = mode;
    for (const b of document.querySelectorAll('.mm-mode')) b.classList.toggle('active', b.dataset.mode === mode);
    $('mm-mode-desc').textContent = MODES[mode].desc;
    if (mode !== 'practice') $('menu-mode').value = mode;
  }

  // ---- playing ----------------------------------------------------------------------------
  /** GO: practice offline, or find the busiest open lobby of this mode. */
  async go() {
    if (this.busy) return;
    if (this.mode === 'practice') { this.onPlay({ online: false }); return; }
    this.busy = true;
    $('btn-go').disabled = true;
    const m = MODES[this.mode];
    this.status(`Looking for a ${m.name} lobby…`);
    await this.refresh(true);
    const open = this.lobbies
      .filter((l) => l.mode === m.server && l.players < l.max && l.phase !== 'matchend')
      .sort((a, b) => b.players - a.players);
    const pick = open[0];
    const code = pick ? pick.code : `${this.mode}-${Math.random().toString(36).slice(2, 6)}`;
    this.status(pick ? `Joining ${code} (${pick.players}/${pick.max} players)…` : `No open ${m.name} lobby, so you're starting ${code}. Others will find it in Lobbies.`);
    this.busy = false;
    $('btn-go').disabled = false;
    this.onPlay({ online: true, code, mode: this.mode });
  }

  join(code) {
    const lobby = this.lobbies.find((l) => l.code === code);
    const mode = lobby ? Object.keys(MODES).find((k) => MODES[k].server === lobby.mode) : $('menu-mode').value;
    this.onPlay({ online: true, code, mode });
  }

  joinTyped() {
    const code = clean($('menu-lobby').value);
    if (!code) { this.status('Type a lobby name first (letters, numbers, - and _).'); return; }
    $('menu-lobby').value = code;
    this.join(code);
  }

  // ---- the lobby finder ------------------------------------------------------------------------
  async refresh(quiet = false) {
    try {
      const res = await fetch('/api/lobbies', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      this.lobbies = (await res.json()).lobbies || [];
      this.offline = false;
    } catch {
      this.lobbies = [];
      this.offline = true;
      if (!quiet && this.current === 'lobbies') this.status('Can\'t reach the lobby list (are you running the game with npm run dev?).');
    }
    this.render();
  }

  /** Keep the list fresh while it's on screen (and only then: each refresh is a request). */
  schedule() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.visible && this.current === 'lobbies' && document.visibilityState === 'visible') {
      this.timer = setInterval(() => this.refresh(true), REFRESH_MS);
    }
  }

  render() {
    const filter = $('lobby-filter').value;
    const rows = this.lobbies.filter((l) => !filter || l.mode === filter);
    const body = $('lobby-rows');
    body.innerHTML = '';
    for (const l of rows) {
      const full = l.players >= l.max;
      const tr = document.createElement('tr');
      if (full) tr.className = 'full';
      tr.innerHTML =
        `<td><b>${l.code}</b></td><td>${SERVER_NAMES[l.mode] || l.mode}</td><td>${l.map}</td>` +
        `<td class="num">${l.players} / ${l.max}</td><td>${statusText(l)}</td>` +
        `<td>${full ? 'Full' : `<button class="mm-small primary" data-join="${l.code}">Join</button>`}</td>`;
      body.appendChild(tr);
    }
    $('lobby-empty').classList.toggle('hidden', rows.length > 0);
    $('lobby-empty').textContent = this.offline
      ? 'The lobby list isn\'t available here. You can still join a lobby by name.'
      : 'No open lobbies right now. Create one, or press GO on the Play tab and others will find you.';
  }
}

function statusText(l) {
  if (l.mode === 'deathmatch') return 'In progress';
  if (l.phase === 'warmup') return 'Warmup — join now';
  if (l.phase === 'matchend') return 'Match over';
  return `Round ${l.round} · T ${l.scoreT} – ${l.scoreCT} CT`;
}

export function clean(code) {
  return String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}
