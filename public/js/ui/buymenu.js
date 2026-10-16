// ---------------------------------------------------------------------------
// buymenu.js — the B menu, laid out like CS2's:
//
//   1 PISTOLS   2 MID-TIER   3 RIFLES   4 EQUIPMENT   5 GRENADES
//
// Each column has up to 5 numbered cards. Buy by clicking, or with number
// keys: B, then the column, then the card (B 3 2 = 2nd rifle). Right-click
// something you bought this round to refund it (CS2 sell-back). LOADOUT lets
// you choose which weapon sits in each slot (config/loadout.js has the
// defaults). The server still checks money, buy zone and buy time.
// ---------------------------------------------------------------------------

import { WEAPONS, EQUIPMENT } from '../../shared/weapons.js';
import { RULES } from '../../shared/rules.js';
import { inBox } from '../../shared/economy.js';
import { MAP } from '../../config/map.js';
import {
  EQUIPMENT_COLUMN, GRENADE_COLUMN, loadLoadout, saveLoadout, slotOptions,
} from '../../config/loadout.js';
import { WeaponIcons } from './weaponIcons.js';

const COLUMNS = [
  { key: 'pistols', title: 'Pistols' },
  { key: 'mid', title: 'Mid-Tier' },
  { key: 'rifles', title: 'Rifles' },
  { key: 'equipment', title: 'Equipment' },
  { key: 'grenades', title: 'Grenades' },
];
const EQUIP_INFO = {
  vest: 'Body armor: takes damage instead of you for body shots.',
  vesthelm: 'Body armor and a helmet. Without a helmet, headshots ignore your armor.',
  helmet: 'Adds a helmet to your armor.',
  defuser: 'Defuses the bomb in 5 seconds instead of 10.',
};
const NADE_INFO = {
  he: 'Explodes after a short fuse. Damage falls off with distance.',
  flash: 'Blinds anyone looking at it when it goes off. You can carry two.',
  smoke: 'Blocks vision for 18 seconds and puts out fire.',
  molotov: 'Sets the ground on fire. Smoke puts it out.',
  incendiary: 'Sets the ground on fire. Smoke puts it out.',
  decoy: 'Makes the sound of your gun firing.',
  zeus: 'One-shot taser with a short range. Recharges.',
};

const money = (n) => '$' + Math.max(0, Math.floor(n)).toLocaleString('en-US');
const $ = (id) => document.getElementById(id);

export class BuyMenu {
  // Created once; attach() points it at the current game.
  constructor(input, models) {
    this.game = null;
    this.input = input;
    this.icons = new WeaponIcons(models);
    this.el = $('buymenu');
    this.open = false;
    this.column = -1; // selected with a number key
    this.editing = false; // loadout edit mode
    this.picker = null; // { tier, index } while choosing a weapon for a slot
    this.hover = null;
    this.bought = []; // items bought this round (refundable)
    this.loadout = loadLoadout();
    input.on('buy', (down) => { if (down && this.game) this.toggle(); });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.close(); });
  }

  attach(game) {
    if (this.open) this.close();
    this.game = game;
    this.bought = [];
    game.on('event', (ev) => {
      if (ev.type === 'buyResult') {
        if (ev.ok) this.bought.push(ev.item);
        else this.flash(ev.reason);
        if (this.open) this.render();
      } else if (ev.type === 'refundResult') {
        if (ev.ok) {
          const i = this.bought.lastIndexOf(ev.item);
          if (i >= 0) this.bought.splice(i, 1);
          this.flash(`Refunded ${this.nameOf(ev.item)} (+${money(ev.price)})`);
        } else this.flash(ev.reason);
        if (this.open) this.render();
      } else if (ev.type === 'spawn' && ev.id === game.localId) {
        this.bought = [];
      }
    });
  }

  // ---- opening / closing ------------------------------------------------------------------
  toggle() {
    if (this.open) this.close(); else this.show();
  }

  show() {
    if (!this.game.alive) return;
    this.open = true;
    this.column = -1;
    this.picker = null;
    this.game.menuOpen = true;
    this.input.menuCapture = true;
    this.render();
    this.el.classList.remove('hidden');
    this.input.unlock(); // show the mouse cursor
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.editing = false;
    this.picker = null;
    this.input.menuCapture = false;
    this.el.classList.add('hidden');
    this.input.lock();
    setTimeout(() => { if (this.game) this.game.menuOpen = false; }, 300);
  }

  onKey(e) {
    if (!this.open) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.picker) { this.picker = null; this.render(); } else this.close();
      return;
    }
    if (e.code === 'Backspace' && this.column >= 0) { e.preventDefault(); this.column = -1; this.render(); return; }
    const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const n = Number(m[1]);
    if (this.picker) return;
    if (this.column < 0) {
      if (n >= 1 && n <= COLUMNS.length) { this.column = n - 1; this.render(); }
    } else {
      const items = this.columnItems(this.column);
      const id = items[n - 1];
      if (id) this.buy(id);
      this.column = -1;
      this.render();
    }
  }

  // ---- what's in each column ------------------------------------------------------------
  teamName() { return this.game.team === 2 ? 'CT' : 'T'; }

  columnItems(ci) {
    const team = this.teamName();
    const key = COLUMNS[ci].key;
    if (key === 'equipment') return EQUIPMENT_COLUMN[team];
    if (key === 'grenades') return GRENADE_COLUMN[team];
    return this.loadout[team][key];
  }

  nameOf(id) { return (WEAPONS[id] || EQUIPMENT[id] || { name: id }).name; }

  clsOf(id) { return WEAPONS[id] ? WEAPONS[id].cls : 'equipment'; }

  priceOf(id) {
    const hs = this.game.hudState;
    if (id === 'vesthelm' && hs.armor >= 100 && !hs.helmet) return EQUIPMENT.helmet.price;
    return (WEAPONS[id] || EQUIPMENT[id]).price;
  }

  /** Do we have this item right now? */
  owns(id) {
    const ws = this.game.ws, hs = this.game.hudState;
    if (id === 'vest') return hs.armor >= 100;
    if (id === 'vesthelm') return hs.armor >= 100 && hs.helmet;
    if (id === 'defuser') return hs.defuser;
    const def = WEAPONS[id];
    if (!def) return false;
    if (def.slot === 'primary') return ws.pri === def.index;
    if (def.slot === 'secondary') return ws.sec === def.index;
    if (def.slot === 'zeus') return !!ws.zeus;
    if (id === 'molotov' || id === 'incendiary') return ws.fire === def.index;
    if (def.slot === 'grenade') return ws[id] > 0;
    return false;
  }

  /** Can we buy right now? null = yes, otherwise the reason. */
  buyBlocked() {
    const g = this.game;
    const free = g.serverMode === 'practice' || g.serverMode === 'deathmatch' || g.mode === 'practice';
    if (free) return null;
    const st = g.roundHud && g.roundHud.state;
    if (st && st.phase !== 'warmup') {
      const left = this.buyTimeLeft();
      if (left !== null && left <= 0) return 'Buy time is over';
    }
    const zone = MAP.buyzones && MAP.buyzones[this.teamName()];
    if (zone && !inBox(g.pred.pos, zone)) return 'Not in a buy zone';
    return null;
  }

  /** Seconds of buy time left, or null if there's no limit right now. */
  buyTimeLeft() {
    const g = this.game;
    const st = g.roundHud && g.roundHud.state;
    if (!st || st.phase === 'warmup' || g.serverMode === 'deathmatch') return null;
    const elapsed = (g.serverTickEst - st.recvTick) / 64;
    if (st.phase === 'freeze') return Math.max(0, st.timeLeft - elapsed) + RULES.BUY_TIME;
    if (st.phase === 'live' || st.phase === 'planted') return Math.max(0, st.buyLeft - elapsed);
    return 0;
  }

  // ---- actions ------------------------------------------------------------------------
  buy(id) {
    if (this.owns(id) && !(WEAPONS[id] && WEAPONS[id].slot === 'grenade' && id === 'flash')) {
      this.flash(`You already have ${this.nameOf(id)}`);
      return;
    }
    this.game.transport.send(JSON.stringify({ type: 'buy', item: id }));
  }

  refund(id) {
    if (!this.bought.includes(id)) { this.flash('Only things you bought this round can be refunded'); return; }
    this.game.transport.send(JSON.stringify({ type: 'refund', item: id }));
  }

  flash(text) {
    const n = $('hud-notice');
    if (!n) return;
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => n.classList.remove('show'), 2200);
  }

  setSlot(tier, index, id) {
    const team = this.teamName();
    const list = this.loadout[team][tier];
    const other = list.indexOf(id);
    if (other >= 0) list[other] = list[index]; // swap places
    list[index] = id;
    saveLoadout(this.loadout);
    this.picker = null;
    this.render();
  }

  // ---- drawing --------------------------------------------------------------------------
  card(id, num, opts = {}) {
    const def = WEAPONS[id];
    const cls = this.clsOf(id);
    const price = this.priceOf(id);
    const owned = this.owns(id);
    const refundable = owned && this.bought.includes(id);
    const poor = !owned && this.game.hudState.money < price;
    const el = document.createElement('button');
    el.className = 'bm-card' + (owned ? ' owned' : '') + (poor ? ' poor' : '') + (opts.slot ? ' editable' : '');
    el.innerHTML =
      `<span class="bm-num">${num}</span>` +
      `<img class="bm-img" alt="" draggable="false">` +
      `<span class="bm-name">${this.nameOf(id)}</span>` +
      `<span class="bm-price">${money(price)}</span>` +
      (opts.slot && this.editing ? '<span class="bm-tag swap">SWAP ⇄</span>'
        : refundable ? '<span class="bm-tag refund">REFUND ⟲</span>' : owned ? '<span class="bm-tag">EQUIPPED</span>' : '');
    const img = el.querySelector('img');
    img.src = this.icons.now(id, cls);
    this.icons.get(id, cls).then((url) => { img.src = url; });
    el.addEventListener('mouseenter', () => { this.hover = id; this.renderInfo(); });
    el.addEventListener('mouseleave', () => { if (this.hover === id) { this.hover = null; this.renderInfo(); } });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (opts.pick) { opts.pick(); return; }
      if (e.button === 2) { this.refund(id); return; }
      if (e.button !== 0) return;
      if (this.editing && opts.slot) { this.picker = opts.slot; this.render(); return; }
      this.buy(id);
    });
    void def;
    return el;
  }

  render() {
    const g = this.game;
    this.el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'bm-panel ' + (g.team === 2 ? 'ct' : 't');

    const head = document.createElement('div');
    head.className = 'bm-head';
    head.innerHTML =
      `<div class="bm-money" id="bm-money">${money(g.hudState.money)}</div>` +
      '<div class="bm-status" id="bm-status"></div>' +
      `<button class="bm-btn${this.editing ? ' on' : ''}" id="bm-edit">${this.editing ? 'DONE' : 'LOADOUT'}</button>` +
      '<button class="bm-btn" id="bm-close">CLOSE [B]</button>';
    panel.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'bm-grid';
    COLUMNS.forEach((col, ci) => {
      const c = document.createElement('div');
      c.className = 'bm-col' + (this.column === ci ? ' selected' : '');
      const h = document.createElement('div');
      h.className = 'bm-col-head';
      h.innerHTML = `<span class="bm-key">${ci + 1}</span>${col.title}`;
      c.appendChild(h);
      const tier = ci < 3 ? col.key : null;
      this.columnItems(ci).forEach((id, i) => {
        c.appendChild(this.card(id, i + 1, tier ? { slot: { tier, index: i } } : {}));
      });
      grid.appendChild(c);
    });
    panel.appendChild(grid);

    const foot = document.createElement('div');
    foot.className = 'bm-foot';
    foot.innerHTML = '<div class="bm-info" id="bm-info"></div><div class="bm-gear" id="bm-gear"></div>';
    panel.appendChild(foot);
    const hint = document.createElement('div');
    hint.className = 'bm-hint';
    hint.textContent = this.editing
      ? 'Click a pistol, mid-tier or rifle slot to choose what goes there. Saved in this browser.'
      : 'Click or press the numbers to buy · Right-click something you bought this round to refund it · Backspace: back · Esc: close';
    panel.appendChild(hint);

    if (this.picker) panel.appendChild(this.renderPicker());
    this.el.appendChild(panel);
    panel.querySelector('#bm-edit').addEventListener('click', () => { this.editing = !this.editing; this.picker = null; this.render(); });
    panel.querySelector('#bm-close').addEventListener('click', () => this.close());
    this.renderInfo();
    this.renderGear();
    this.update();
  }

  renderPicker() {
    const { tier, index } = this.picker;
    const team = this.teamName();
    const wrap = document.createElement('div');
    wrap.className = 'bm-picker';
    const title = document.createElement('div');
    title.className = 'bm-picker-title';
    title.innerHTML = `<span>Choose ${tier === 'pistols' && index === 0 ? 'your starting pistol' : `${COLUMNS.find((c) => c.key === tier).title} slot ${index + 1}`}</span>`;
    const cancel = document.createElement('button');
    cancel.className = 'bm-btn';
    cancel.textContent = 'CANCEL [ESC]';
    cancel.addEventListener('click', () => { this.picker = null; this.render(); });
    title.appendChild(cancel);
    wrap.appendChild(title);
    const list = document.createElement('div');
    list.className = 'bm-picker-list';
    const current = this.loadout[team][tier];
    slotOptions(tier, index, team).forEach((id) => {
      const card = this.card(id, current.indexOf(id) >= 0 ? current.indexOf(id) + 1 : '·', { pick: () => this.setSlot(tier, index, id) });
      if (current[index] === id) card.classList.add('current');
      list.appendChild(card);
    });
    wrap.appendChild(list);
    return wrap;
  }

  renderInfo() {
    const box = this.el.querySelector('#bm-info');
    if (!box) return;
    const id = this.hover;
    if (!id) { box.innerHTML = '<div class="bm-info-empty">Point at an item to see its stats</div>'; return; }
    const def = WEAPONS[id];
    let rows = '';
    if (def && def.damage && def.cls !== 'grenade') {
      const stat = (label, value, frac) => `<div class="bm-stat"><span>${label}</span><b>${value}</b><i style="width:${Math.round(Math.max(0.04, Math.min(1, frac)) * 100)}%"></i></div>`;
      rows =
        stat('Damage', def.damage + (def.pellets > 1 ? ` × ${def.pellets}` : ''), (def.damage * (def.pellets || 1)) / 120) +
        stat('Armor penetration', (def.armorPen || 0) + '%', (def.armorPen || 0) / 100) +
        stat('Fire rate', Math.round(def.rpm) + ' RPM', def.rpm / 1000) +
        stat('Magazine', `${def.clip} / ${def.reserve}`, def.clip / 100) +
        stat('Running speed', def.speed, def.speed / 250);
    }
    const extra = NADE_INFO[id] || EQUIP_INFO[id] || '';
    const reward = def && def.killReward !== undefined && def.cls !== 'grenade' ? `<div class="bm-reward">Kill reward: ${money(def.killReward)}</div>` : '';
    box.innerHTML = `<div class="bm-info-name">${this.nameOf(id)} <span>${money(this.priceOf(id))}</span></div>${rows ? `<div class="bm-stats">${rows}</div>` : ''}${extra ? `<div class="bm-desc">${extra}</div>` : ''}${reward}`;
  }

  renderGear() {
    const box = this.el.querySelector('#bm-gear');
    if (!box) return;
    const ws = this.game.ws, hs = this.game.hudState;
    const items = [];
    const add = (id) => { if (id) items.push(id); };
    add(ws.pri && Object.values(WEAPONS).find((d) => d.index === ws.pri)?.id);
    add(ws.sec && Object.values(WEAPONS).find((d) => d.index === ws.sec)?.id);
    if (ws.zeus) add('zeus');
    if (ws.fire) add(Object.values(WEAPONS).find((d) => d.index === ws.fire)?.id);
    for (const n of ['he', 'flash', 'smoke', 'decoy']) for (let i = 0; i < (ws[n] || 0); i++) add(n);
    if (hs.armor > 0) add(hs.helmet ? 'vesthelm' : 'vest');
    if (hs.defuser) add('defuser');
    box.innerHTML = '<div class="bm-gear-title">Your equipment</div>';
    const row = document.createElement('div');
    row.className = 'bm-gear-row';
    for (const id of items) {
      const img = document.createElement('img');
      img.title = this.nameOf(id);
      img.src = this.icons.now(id, this.clsOf(id));
      this.icons.get(id, this.clsOf(id)).then((url) => { img.src = url; });
      row.appendChild(img);
    }
    if (!items.length) row.textContent = '—';
    box.appendChild(row);
  }

  /** Called every frame by presentation.js. */
  update() {
    if (!this.open || !this.game) return;
    const g = this.game;
    if (!g.alive) { this.close(); return; }
    const m = this.el.querySelector('#bm-money');
    if (m) m.textContent = money(g.hudState.money);
    const s = this.el.querySelector('#bm-status');
    if (s) {
      const blocked = this.buyBlocked();
      const left = this.buyTimeLeft();
      const warmup = g.roundHud && g.roundHud.state && g.roundHud.state.phase === 'warmup';
      const secs = left === null ? 0 : Math.ceil(left);
      const text = blocked || (left === null ? (warmup ? 'Warmup: buy anywhere' : '') : `Buy time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
      if (s.textContent !== text) s.textContent = text;
      s.classList.toggle('blocked', !!blocked);
    }
    // re-render when what we own changes (purchases arrive via snapshots)
    const sig = `${g.ws.pri},${g.ws.sec},${g.ws.zeus},${g.ws.he},${g.ws.flash},${g.ws.smoke},${g.ws.fire},${g.ws.decoy},${g.hudState.armor},${g.hudState.helmet},${g.hudState.defuser},${g.hudState.money >= 0 ? Math.floor(g.hudState.money / 50) : 0},${g.team}`;
    if (sig !== this.sig) { this.sig = sig; if (!this.picker) this.render(); }
  }
}
