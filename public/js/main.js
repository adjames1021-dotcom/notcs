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
import { RoundHud } from './ui/round.js';
import { Radar } from './ui/radar.js';
import { MainMenu, MODES, clean } from './ui/mainmenu.js';

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
$('menu-name').addEventListener('change', () => { settings.name = $('menu-name').value.trim().slice(0, 20); saveSettings(settings); });

function status(text) { $('menu-status').textContent = text || ''; }

const menu = new MainMenu({ onPlay: (opts) => start(opts), status });

// The map loads in the background as soon as the page opens (it's shown
// behind the menu), so pressing GO is quick.
let mapPromise = null;
function loadMap() {
  if (!mapPromise) {
    mapPromise = (async () => {
      const res = await fetch(MAP.file);
      if (!res.ok) throw new Error(`Could not load ${MAP.file} (${res.status})`);
      const buffer = await res.arrayBuffer();
      const geo = loadMapGeometry(buffer, MAP);
      for (const line of geo.report) console.log(line);
      const world = new CollisionWorld(geo.triangles);
      renderer = renderer || new Renderer(canvas, settings);
      window.__renderer = renderer; // handy for debugging in the browser console
      await renderer.loadMap(buffer.slice(0), geo);
      renderer.markStatic();
      mapData = { geo, world };
      return mapData;
    })();
    mapPromise.catch(() => { mapPromise = null; });
  }
  return mapPromise;
}

// ---- the live map behind the menu (a slow camera drifting past dust2) ----
const SHOTS = [
  { from: [520, 2380, 150], to: [700, 2330, 160], yaw: 25, turn: 14, pitch: 6 }, // A site from the CT side
  { from: [-380, 290, 200], to: [-380, 430, 200], yaw: 90, turn: -6, pitch: 5 }, // mid towards CT
  { from: [-1700, 1750, 110], to: [-1780, 1960, 120], yaw: 82, turn: 12, pitch: 5 }, // B from the tunnels
  { from: [-1520, -1010, 260], to: [-1500, -930, 265], yaw: 60, turn: 16, pitch: 10 }, // over T spawn
];
const SHOT_SECONDS = 14;
window.__menuShots = SHOTS;
let backdrop = 0;
function startBackdrop() {
  if (backdrop || game || !renderer || !mapData) return;
  $('menu').classList.remove('no-backdrop');
  const t0 = performance.now();
  const loop = (now) => {
    if (game || !menu.visible) { backdrop = 0; return; }
    const t = Math.max(0, now - t0) / 1000;
    const shot = SHOTS[Math.floor(t / SHOT_SECONDS) % SHOTS.length];
    const k = (t % SHOT_SECONDS) / SHOT_SECONDS;
    const e = k * k * (3 - 2 * k) * 0.6 + k * 0.4; // gentle ease
    const p = shot.from.map((v, i) => v + (shot.to[i] - v) * e);
    renderer.setView(p, shot.yaw + shot.turn * e, shot.pitch);
    renderer.render();
    backdrop = requestAnimationFrame(loop);
  };
  backdrop = requestAnimationFrame(loop);
}
$('menu').classList.add('no-backdrop');
loadMap().then(() => startBackdrop()).catch((err) => { console.error(err); status('Error: ' + err.message); });

/** @param opts { online, code, mode } from the menu */
async function start({ online, code, mode } = {}) {
  if (game) return;
  settings.name = $('menu-name').value.trim().slice(0, 20);
  saveSettings(settings);
  const lobby = clean(code);
  if (online && !lobby) { status('Type a lobby name first.'); return; }
  $('loading').classList.remove('hidden');
  if (!mapData) status('Loading the map…');
  try {
    const { world } = await loadMap();
    const audio = new Audio(settings);
    audio.unlock();
    const input = window.__input || (window.__input = new Input(canvas, settings));
    let transport;
    let token = null;
    if (online) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const m = MODES[mode] ? mode : 'comp';
      transport = new WebSocketTransport(`${proto}//${location.host}/ws/${encodeURIComponent(lobby)}?mode=${m}`);
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
    window.__buyMenu = window.__buyMenu || new BuyMenu(input, models);
    window.__feed = window.__feed || new Feed(input);
    window.__buyMenu.attach(game);
    window.__feed.attach(game);
    window.__round = window.__round || new RoundHud(input);
    window.__round.attach(game, renderer, models);
    game.roundHud = window.__round;
    window.__radar = window.__radar || new Radar();
    window.__radar.attach(game);
    game.radar = window.__radar;
    game.buyMenu = window.__buyMenu;
    window.__game = game; // handy for debugging in the browser console
    game.on('welcome', (msg) => {
      if (online) { try { sessionStorage.setItem('notcs.token.' + lobby, msg.token); } catch { /* ignore */ } }
    });
    // Dropped connections are retried inside the game (game.js) and your
    // player waits for you on the server; this only fires if that gave up.
    game.on('connection', (c) => showNetBanner(c));
    game.on('disconnected', (message) => {
      if (!game || !game.running) return;
      leave();
      status(message || 'Disconnected from server.');
    });
    game.on('error', (m) => status(m));
    game.start(settings.name || 'Player', token);
    menu.hide();
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

function showNetBanner(c) {
  const el = $('net-banner');
  if (c.state === 'connected') { el.classList.add('hidden'); return; }
  el.textContent = c.state === 'idle'
    ? 'Disconnected for being idle — rejoining…'
    : `Connection lost — reconnecting${c.attempt > 1 ? ` (try ${c.attempt})` : ''}…`;
  el.classList.remove('hidden');
}

function leave() {
  $('net-banner').classList.add('hidden');
  if (game) { game.stop(); game = null; }
  if (renderer) renderer.clearDynamic();
  window.__input?.unlock();
  $('hud').classList.add('hidden');
  $('paused').classList.add('hidden');
  menu.show();
  startBackdrop();
}

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
