// ---------------------------------------------------------------------------
// modelCheck.js — the /model-check.html page: preview every weapon model in
// first person and tune its placement. Not used by the game itself.
// ---------------------------------------------------------------------------

import { Renderer, THREE } from '../render/renderer.js';
import { ModelLibrary } from '../render/models.js';
import { Viewmodel } from '../render/viewmodel.js';
import { WEAPON_MODELS, VIEWMODEL_DEFAULTS } from '../../config/models.js';
import { WEAPONS } from '../../shared/weapons.js';
import { loadSettings } from '../settings.js';

const settings = loadSettings();
settings.shadows = false;
const renderer = new Renderer(document.getElementById('game'), settings);
renderer.scene.background = new THREE.Color(0x8a7a62);
const models = new ModelLibrary();
const vm = new Viewmodel(renderer, models);
const sel = document.getElementById('weapon');
for (const id of Object.keys(WEAPON_MODELS)) {
  const def = WEAPONS[id];
  if (!def) continue;
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `${def.name} (${id})`;
  sel.appendChild(o);
}
const params = new URLSearchParams(location.search);
if (params.get('w')) sel.value = params.get('w');

let view = null;
const sliders = document.getElementById('sliders');
const out = document.getElementById('out');
const info = document.getElementById('info');

function makeSliders() {
  sliders.innerHTML = '';
  const rows = [['pos', 0, 'forward', 0, 40], ['pos', 1, 'left(+)/right(-)', -20, 20], ['pos', 2, 'up(+)/down(-)', -20, 10],
    ['rot', 0, 'pitch (down +)', -90, 90], ['rot', 1, 'yaw (left +)', -90, 90], ['rot', 2, 'roll', -180, 180]];
  for (const [key, i, label, min, max] of rows) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const r = document.createElement('input');
    r.type = 'range'; r.min = min; r.max = max; r.step = 0.1; r.value = view[key][i];
    const span = document.createElement('span');
    span.textContent = `${label}: ${view[key][i]}`;
    r.addEventListener('input', () => { view[key][i] = Number(r.value); span.textContent = `${label}: ${r.value}`; apply(); });
    row.append(span, r);
    sliders.appendChild(row);
  }
}

function apply() {
  if (vm.current) vm.current.view = view;
  out.textContent = `${sel.value}: { ...WEAPON_MODELS.${sel.value}, view: { pos: [${view.pos.map((v) => +v.toFixed(1)).join(', ')}], rot: [${view.rot.map((v) => +v.toFixed(1)).join(', ')}] } },`;
}

function choose() {
  const def = WEAPONS[sel.value];
  const cfg = WEAPON_MODELS[sel.value] || {};
  const base = VIEWMODEL_DEFAULTS[def.cls] || VIEWMODEL_DEFAULTS.rifle;
  view = { pos: [...(cfg.view?.pos || base.pos)], rot: [...(cfg.view?.rot || base.rot)] };
  vm.setWeapon(null);
  vm.setWeapon(def);
  models.load(def.id, def.cls).then((e) => {
    info.textContent = e.placeholder
      ? 'No model file yet — showing a placeholder.'
      : `Loaded. Length ${e.length.toFixed(1)} units (an AK is ~35).`;
    setTimeout(apply, 0);
  });
  makeSliders();
  apply();
}
sel.addEventListener('change', choose);
choose();

renderer.setView([0, 0, 64], 0, 0);
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (vm.current) vm.current.view = view;
  vm.update({ dt, speed: 0, onGround: true, mouseDX: 0, mouseDY: 0, deploy: 1, reload: -1, scoped: false, silenced: false });
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__vm = { vm, models, choose, sel, setView: (v) => { view = v; makeSliders(); apply(); } };
