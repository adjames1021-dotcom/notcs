// ---------------------------------------------------------------------------
// menus.js — Settings and Controls screens.
// ---------------------------------------------------------------------------

import { drawCrosshair } from './crosshair.js';
import { DEFAULT_SETTINGS } from '../settings.js';

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function numberRow(label, obj, key, { min, max, step }, onChange) {
  const range = el('input', { type: 'range', min, max, step });
  const num = el('input', { type: 'number', min, max, step });
  range.value = num.value = obj[key];
  const set = (v) => {
    const n = Math.max(min, Math.min(max, Number(v)));
    if (!Number.isFinite(n)) return;
    obj[key] = n; range.value = num.value = n; onChange();
  };
  range.addEventListener('input', () => set(range.value));
  num.addEventListener('change', () => set(num.value));
  return el('div', { class: 'setting-row' }, [el('span', { text: label }), range, num]);
}

function checkRow(label, obj, key, onChange) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = !!obj[key];
  cb.addEventListener('change', () => { obj[key] = cb.checked; onChange(); });
  return el('label', { class: 'setting-row' }, [el('span', { text: label }), cb]);
}

function selectRow(label, obj, key, options, onChange) {
  const sel = el('select');
  for (const [v, text] of options) { const o = el('option', { value: v, text }); sel.appendChild(o); }
  sel.value = obj[key];
  sel.addEventListener('change', () => { obj[key] = sel.value; onChange(); });
  return el('label', { class: 'setting-row' }, [el('span', { text: label }), sel]);
}

export function openSettings(settings, onChange) {
  const box = $('settings');
  box.innerHTML = '';
  const preview = el('div', { id: 'crosshair-preview' });
  const pcanvas = el('canvas');
  pcanvas.style.position = 'absolute';
  pcanvas.style.left = '50%';
  pcanvas.style.top = '50%';
  pcanvas.style.transform = 'translate(-50%,-50%)';
  preview.appendChild(pcanvas);
  const changed = () => { drawCrosshair(pcanvas, settings.crosshair); onChange(); };
  const c = settings.crosshair;
  const color = el('input', { type: 'color' });
  color.value = c.color;
  color.addEventListener('input', () => { c.color = color.value; changed(); });

  const panel = el('div', { class: 'menu-panel' }, [
    el('h2', { text: 'Settings' }),
    el('div', { class: 'setting-section', text: 'Mouse' }),
    numberRow('Sensitivity (CS2 value)', settings, 'sensitivity', { min: 0.05, max: 10, step: 0.01 }, changed),
    numberRow('Zoom sensitivity ratio', settings, 'zoomSensitivityRatio', { min: 0.1, max: 3, step: 0.01 }, changed),
    checkRow('Raw input (no mouse acceleration)', settings, 'rawInput', changed),
    checkRow('Invert mouse', settings, 'invertY', changed),
    checkRow('Mouse wheel down = jump (for bhop)', settings, 'wheelJump', changed),
    el('p', { class: 'small-note', text: 'Same formula as CS2: degrees = mouse counts × sensitivity × 0.022, so you can copy your CS2 sensitivity.' }),
    el('div', { class: 'setting-section', text: 'Crosshair' }),
    preview,
    numberRow('Size', c, 'size', { min: 0, max: 10, step: 0.5 }, changed),
    numberRow('Gap', c, 'gap', { min: -5, max: 10, step: 0.5 }, changed),
    numberRow('Thickness', c, 'thickness', { min: 0.5, max: 4, step: 0.5 }, changed),
    numberRow('Alpha', c, 'alpha', { min: 0, max: 255, step: 5 }, changed),
    el('label', { class: 'setting-row' }, [el('span', { text: 'Color' }), color]),
    selectRow('Style', c, 'style', [['static', 'Classic static'], ['dynamic', 'Classic dynamic']], changed),
    checkRow('Follow recoil', c, 'followRecoil', changed),
    checkRow('Outline', c, 'outline', changed),
    checkRow('Center dot', c, 'dot', changed),
    checkRow('T-style', c, 'tStyle', changed),
    el('div', { class: 'setting-section', text: 'Video & audio' }),
    numberRow('Volume', settings, 'volume', { min: 0, max: 1, step: 0.05 }, changed),
    numberRow('Render scale', settings, 'renderScale', { min: 0.5, max: 1.5, step: 0.05 }, changed),
    numberRow('Viewmodel FOV', settings, 'viewmodelFov', { min: 54, max: 68, step: 1 }, changed),
    checkRow('Shadows (reload to apply)', settings, 'shadows', changed),
    checkRow('Show net graph (fps / ping)', settings, 'showNetGraph', changed),
    el('div', { class: 'setting-section', text: 'Netcode testing (Practice mode)' }),
    numberRow('Fake latency (ms round trip)', settings, 'fakeLagMs', { min: 0, max: 400, step: 10 }, changed),
    numberRow('Fake jitter (ms)', settings, 'fakeJitterMs', { min: 0, max: 100, step: 5 }, changed),
    el('div', { class: 'menu-buttons' }, [
      el('button', { text: 'Reset to defaults', onclick: () => { Object.assign(settings, structuredClone({ ...DEFAULT_SETTINGS, name: settings.name, binds: settings.binds })); onChange(); openSettings(settings, onChange); } }),
      el('button', { class: 'primary', text: 'Done', onclick: () => box.classList.add('hidden') }),
    ]),
  ]);
  box.appendChild(panel);
  box.classList.remove('hidden');
  drawCrosshair(pcanvas, settings.crosshair);
}

const ACTION_LABELS = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right', jump: 'Jump',
  duck: 'Crouch', walk: 'Walk (silent)', use: 'Use / plant / defuse', reload: 'Reload', drop: 'Drop weapon',
  lastWeapon: 'Last weapon', inspect: 'Inspect', slot1: 'Primary', slot2: 'Pistol', slot3: 'Knife', slot4: 'Grenades',
  slot5: 'Bomb', buy: 'Buy menu', score: 'Scoreboard', debug: 'Debug overlay', chat: 'Chat', teamChat: 'Team chat',
  teamMenu: 'Choose team',
};

export function openControls(settings, onChange = () => {}) {
  const box = $('controls');
  box.innerHTML = '';
  let waiting = null;
  const rows = Object.entries(settings.binds).map(([action, codes]) => {
    const btn = el('button', { text: codes.map(prettyKey).join(' / ') || '—' });
    btn.addEventListener('click', () => {
      if (waiting) waiting.btn.textContent = settings.binds[waiting.action].map(prettyKey).join(' / ');
      waiting = { action, btn };
      btn.textContent = 'press a key… (Esc = cancel)';
    });
    return el('tr', {}, [el('td', {}, [btn]), el('td', { text: ACTION_LABELS[action] || action })]);
  });
  const onKey = (e) => {
    if (!waiting) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') {
      // a key can only do one thing: remove it from other actions
      for (const a of Object.keys(settings.binds)) settings.binds[a] = settings.binds[a].filter((c) => c !== e.code);
      settings.binds[waiting.action] = [e.code];
      onChange();
    }
    openControls(settings, onChange);
  };
  window.addEventListener('keydown', onKey, { capture: true, once: false });
  rows.push(el('tr', {}, [el('td', { text: 'Mouse 1 / Mouse 2' }), el('td', { text: 'Shoot / secondary (scope, silencer, burst, knife stab, underhand throw)' })]));
  rows.push(el('tr', {}, [el('td', { text: 'Mouse wheel' }), el('td', { text: 'Switch weapon (or jump, see Settings)' })]));
  rows.push(el('tr', {}, [el('td', { text: 'Esc' }), el('td', { text: 'Release mouse / pause' })]));
  const close = () => { window.removeEventListener('keydown', onKey, { capture: true }); box.classList.add('hidden'); };
  const panel = el('div', { class: 'menu-panel' }, [
    el('h2', { text: 'Controls' }),
    el('p', { class: 'small-note', text: 'Click a key to change it, then press the new key.' }),
    el('table', { class: 'controls-table' }, rows),
    el('p', { class: 'small-note', text: 'Tip: Ctrl+W can close the browser tab. The game asks for fullscreen keyboard lock to prevent it, and C also crouches.' }),
    el('div', { class: 'menu-buttons' }, [el('button', { class: 'primary', text: 'Close', onclick: close })]),
  ]);
  box.appendChild(panel);
  box.classList.remove('hidden');
  box._cleanup && box._cleanup();
  box._cleanup = () => window.removeEventListener('keydown', onKey, { capture: true });
}

function prettyKey(code) {
  return code.replace(/^Key|^Digit/, '').replace('ControlLeft', 'Ctrl').replace('ShiftLeft', 'Shift').replace('Space', 'Space');
}
