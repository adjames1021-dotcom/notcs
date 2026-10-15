// ---------------------------------------------------------------------------
// buymenu.js — the B menu. Shows every weapon/equipment for your team with
// prices; click (or press the numbers, CS-style: B 4 2 = rifles, 2nd) to buy.
// The server checks money, buy zone and buy time.
// ---------------------------------------------------------------------------

import { buyList } from '../../shared/economy.js';
import { TEAM_NAME } from '../../shared/match.js';

const CATEGORIES = [
  { key: 'pistol', title: 'Pistols', match: (i) => i.cls === 'pistol' },
  { key: 'mid', title: 'Mid-Tier', match: (i) => i.cls === 'smg' || i.cls === 'shotgun' || i.cls === 'heavy' },
  { key: 'rifle', title: 'Rifles', match: (i) => i.cls === 'rifle' || i.cls === 'sniper' },
  { key: 'gear', title: 'Equipment', match: (i) => i.cls === 'equipment' || i.cls === 'zeus' },
  { key: 'nade', title: 'Grenades', match: (i) => i.cls === 'grenade' },
];

export class BuyMenu {
  // Created once; attach() points it at the current game.
  constructor(input) {
    this.game = null;
    this.input = input;
    this.el = document.getElementById('buymenu');
    this.open = false;
    this.category = -1;
    input.on('buy', (down) => { if (down && this.game) this.toggle(); });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  attach(game) {
    if (this.open) this.close();
    this.game = game;
    game.on('event', (ev) => {
      if (ev.type === 'buyResult') {
        if (!ev.ok) this.flash(ev.reason);
        else if (this.open) this.render();
      }
    });
  }

  toggle() {
    if (this.open) this.close(); else this.show();
  }

  show() {
    if (!this.game.alive) return;
    this.open = true;
    this.category = -1;
    this.game.menuOpen = true;
    this.input.menuCapture = true;
    this.render();
    this.el.classList.remove('hidden');
    this.input.unlock(); // show the mouse cursor
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.input.menuCapture = false;
    this.el.classList.add('hidden');
    this.input.lock();
    setTimeout(() => { this.game.menuOpen = false; }, 300);
  }

  onKey(e) {
    if (!this.open) return;
    if (e.code === 'Escape') { e.preventDefault(); this.close(); return; }
    const m = /^Digit(\d)$/.exec(e.code);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const n = Number(m[1]);
    if (this.category < 0) {
      if (n >= 1 && n <= CATEGORIES.length) { this.category = n - 1; this.render(); }
    } else {
      const items = this.itemsFor(CATEGORIES[this.category]);
      const it = items[n - 1];
      if (it) this.buy(it.id);
      this.category = -1;
      this.render();
    }
  }

  itemsFor(cat) {
    const team = TEAM_NAME[this.game.team] || 'T';
    return buyList(team).filter(cat.match).sort((a, b) => (b.available - a.available) || (a.price - b.price));
  }

  buy(id) {
    this.game.transport.send(JSON.stringify({ type: 'buy', item: id }));
  }

  flash(text) {
    const n = document.getElementById('hud-notice');
    if (!n) return;
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => n.classList.remove('show'), 2200);
  }

  render() {
    const money = this.game.hudState.money;
    this.el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'buy-panel';
    const head = document.createElement('div');
    head.className = 'buy-head';
    head.innerHTML = `<span>BUY MENU</span><span class="buy-money">$${money}</span><span class="buy-hint">Click to buy · number keys · B / Esc to close</span>`;
    panel.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'buy-grid';
    CATEGORIES.forEach((cat, ci) => {
      const col = document.createElement('div');
      col.className = 'buy-col' + (this.category === ci ? ' active' : '');
      const h = document.createElement('div');
      h.className = 'buy-cat';
      h.textContent = `${ci + 1}  ${cat.title}`;
      col.appendChild(h);
      this.itemsFor(cat).forEach((it, i) => {
        const b = document.createElement('button');
        b.className = 'buy-item';
        const afford = money >= it.price;
        if (!it.available) b.classList.add('wrong-team');
        else if (!afford) b.classList.add('poor');
        b.innerHTML = `<span class="num">${i + 1}</span><span class="nm">${it.name}</span><span class="pr">$${it.price}</span>`;
        b.disabled = !it.available;
        b.title = it.available ? '' : `${it.team} only`;
        b.addEventListener('click', () => this.buy(it.id));
        col.appendChild(b);
      });
      grid.appendChild(col);
    });
    panel.appendChild(grid);
    this.el.appendChild(panel);
  }

  update() {
    if (this.open) {
      const m = this.el.querySelector('.buy-money');
      if (m) m.textContent = '$' + this.game.hudState.money;
      if (!this.game.alive) this.close();
    }
  }
}
