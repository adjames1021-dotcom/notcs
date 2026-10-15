// ---------------------------------------------------------------------------
// main.js — start-up: menu, loading the map, starting Practice or Online.
// ---------------------------------------------------------------------------

import { MAP } from '../config/map.js';
import { loadMapGeometry } from '../shared/mapLoader.js';
import { CollisionWorld } from '../shared/collision.js';
import { MatchServer } from '../shared/server.js';
import { Renderer } from './render/renderer.js';
import { PlayerViews } from './render/players.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Hud } from './ui/hud.js';
import { Audio } from './audio.js';
import { LocalTransport, WebSocketTransport } from './net.js';
import { loadSettings, saveSettings } from './settings.js';
import { openSettings, openControls } from './ui/menus.js';
import { ModelLibrary } from './render/models.js';
import { Presentation } from './presentation.js';
import { BuyMenu } from './ui/buymenu.js';
import { Feed } from './ui/feed.js';

const $ = (id) => document.getElementById(id);

console.log('%cnotcs — FREE fan project. It will never be sold or monetized. Not affiliated with Valve.',
  'color:#f0b232;font-weight:bold;font-size:14px');

const settings = loadSettings();
const canvas = $('game');
let renderer = null;
let mapData = null; // { geo, world }
let game = null;
let models = null;

$('menu-name').value = settings.name || '';
try {
  const params = new URLSearchParams(location.search);
  if (params.get('lobby')) $('menu-lobby').value = params.get('lobby');
} catch { /* ignore */ }

function status(text) { $('menu-status').textContent = text || ''; }

async function loadMap() {
  if (mapData) return mapData;
  status('Downloading map…');
  const res = await fetch(MAP.file);
  if (!res.ok) throw new Error(`Could not load ${MAP.file} (${res.status})`);
  const buffer = await res.arrayBuffer();
  status('Building collision…');
  const geo = loadMapGeometry(buffer, MAP);
  for (const line of geo.report) console.log(line);
  const world = new CollisionWorld(geo.triangles);
  status('Preparing graphics…');
  renderer = renderer || new Renderer(canvas, settings);
  await renderer.loadMap(buffer.slice(0), geo);
  renderer.markStatic();
  mapData = { geo, world };
  return mapData;
}

async function start(online) {
  settings.name = $('menu-name').value.trim().slice(0, 20);
  saveSettings(settings);
  const lobby = $('menu-lobby').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (online && !lobby) { status('Type a lobby code first (share it with your friends).'); return; }
  $('loading').classList.remove('hidden');
  try {
    const { world } = await loadMap();
    const audio = new Audio(settings);
    audio.unlock();
    const input = window.__input || (window.__input = new Input(canvas, settings));
    let transport;
    let token = null;
    if (online) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      transport = new WebSocketTransport(`${proto}//${location.host}/ws/${encodeURIComponent(lobby)}`);
      try { token = sessionStorage.getItem('notcs.token.' + lobby); } catch { /* ignore */ }
    } else {
      // Practice: run the real server code right here in the page.
      const server = new MatchServer({ world, map: MAP, mode: 'practice', log: (m) => console.log('[server]', m) });
      window.__server = server;
      transport = new LocalTransport(server, { lagMs: settings.fakeLagMs, jitterMs: settings.fakeJitterMs });
    }
    status('Connecting…');
    await transport.connect();
    const hud = new Hud(settings);
    models = models || new ModelLibrary();
    game = new Game({
      renderer, input, transport, world, settings, hud, audio, mode: online ? 'online' : 'practice',
      players: new PlayerViews(renderer, models),
    });
    game.presentation = new Presentation(game, renderer, models);
    // menus are created once and re-attached to each new game
    window.__buyMenu = window.__buyMenu || new BuyMenu(input);
    window.__feed = window.__feed || new Feed(input);
    window.__buyMenu.attach(game);
    window.__feed.attach(game);
    game.buyMenu = window.__buyMenu;
    window.__game = game; // handy for debugging in the browser console
    game.on('welcome', (msg) => {
      if (online) { try { sessionStorage.setItem('notcs.token.' + lobby, msg.token); } catch { /* ignore */ } }
    });
    game.on('disconnected', () => {
      if (!game || !game.running) return;
      status('Disconnected from server.');
      leave();
      if (online) setTimeout(() => status('Disconnected — press Play online to rejoin (you keep your money/score).'), 50);
    });
    game.on('error', (m) => status(m));
    game.start(settings.name || 'Player', token);
    $('menu').classList.add('hidden');
    $('loading').classList.add('hidden');
    hud.show(true);
    status('');
    input.lock();
  } catch (err) {
    console.error(err);
    $('loading').classList.add('hidden');
    status('Error: ' + err.message);
  }
}

function leave() {
  if (game) { game.stop(); game = null; }
  if (renderer) renderer.clearDynamic();
  window.__input?.unlock();
  $('hud').classList.add('hidden');
  $('paused').classList.add('hidden');
  $('menu').classList.remove('hidden');
}

$('btn-practice').addEventListener('click', () => start(false));
$('btn-online').addEventListener('click', () => start(true));
$('menu-lobby').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(true); });
$('btn-settings').addEventListener('click', () => openSettings(settings, () => applySettings()));
$('btn-pause-settings').addEventListener('click', () => openSettings(settings, () => applySettings()));
$('btn-controls').addEventListener('click', () => openControls(settings, () => applySettings()));
$('btn-resume').addEventListener('click', () => window.__input?.lock());
$('btn-leave').addEventListener('click', () => leave());
canvas.addEventListener('click', () => { if (game && !window.__input?.locked) window.__input.lock(); });

function applySettings() {
  saveSettings(settings);
  if (renderer) renderer.resize();
  if (game) {
    game.audio.setVolume(settings.volume);
    game.hud.redrawCrosshair();
    game.input.rebuildBinds();
  }
}

// Pause screen when the mouse is released (Esc).
document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  if (game) $('paused').classList.toggle('hidden', locked || !!game.menuOpen);
});

// Safety net: Ctrl+W (crouch + forward) would close the tab in some browsers.
window.addEventListener('beforeunload', (e) => {
  if (game) { e.preventDefault(); e.returnValue = ''; }
});

// F3 = debug overlay
window.addEventListener('keydown', (e) => {
  if (e.code === 'F3' && game) { e.preventDefault(); game.hud.toggleDebug(); }
});
