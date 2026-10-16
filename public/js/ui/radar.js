// ---------------------------------------------------------------------------
// radar.js — the CS2-style radar in the top-left corner.
//
// The picture is made from the map by tools/build-map.mjs (only floor players
// can reach). It turns with you so "up" is where you're looking, and shows:
//   * you (white arrow) and your teammates (team-coloured dots)
//   * enemies you can currently see (red, they fade a second after)
//   * bombsites A and B
//   * the bomb: planted (flashing), dropped, or which teammate carries it
// Also shows the "plant here" hint when you carry the bomb inside a site.
// ---------------------------------------------------------------------------

import { MAP } from '../../config/map.js';
import { EFLAG } from '../../shared/protocol.js';
import { inBox } from '../../shared/economy.js';
import { createTrace } from '../../shared/collision.js';

const SIZE = 210; // CSS pixels
const RANGE = 2000; // world units across the radar
const TEAM_COLOR = { 1: '#e6b04a', 2: '#6fb2ff' };
const $ = (id) => document.getElementById(id);

export class Radar {
  constructor() {
    this.canvas = $('radar');
    this.hint = $('hud-hint');
    this.ctx = this.canvas.getContext('2d');
    this.game = null;
    this.img = null;
    this.info = null;
    this.spotted = new Map(); // id -> until (ms)
    this.nextSpot = 0;
    this.tr = createTrace();
    const base = MAP.file.replace(/\.glb$/i, '');
    fetch(base + '.radar.json').then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (!info) return;
      const img = new Image();
      img.onload = () => { this.img = img; this.info = info; };
      img.src = base + '.radar.png';
    }).catch(() => {});
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = SIZE * dpr;
    this.canvas.height = SIZE * dpr;
    this.dpr = dpr;
  }

  attach(game) {
    this.game = game;
    this.spotted.clear();
  }

  /** World -> radar picture pixels. */
  toImg(x, y) {
    const i = this.info;
    return [(x - i.minX) / i.unitsPerPixel, (i.maxY - y) / i.unitsPerPixel];
  }

  update() {
    const g = this.game;
    const show = !!(g && this.img && g.localId);
    this.canvas.classList.toggle('hidden', !show);
    if (!show) { this.setHint(''); return; }
    const now = performance.now();
    const eye = g.viewEye || [g.pred.pos[0], g.pred.pos[1], g.pred.pos[2] + 64];
    const spec = g.spectating ? g.entities.get(g.spectating)?.render : null;
    const yaw = spec ? spec.yaw : g.input.yaw;
    if (now >= this.nextSpot) { this.nextSpot = now + 150; this.spot(eye, yaw); }

    const c = this.ctx, i = this.info, d = this.dpr;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, SIZE, SIZE);
    c.save();
    c.beginPath();
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(18, 21, 26, 0.72)';
    c.fillRect(0, 0, SIZE, SIZE);
    // map: rotate so we face up, centred on us
    const k = (SIZE / RANGE) * i.unitsPerPixel; // canvas px per picture px
    const [px, py] = this.toImg(eye[0], eye[1]);
    c.translate(SIZE / 2, SIZE / 2);
    c.rotate(((yaw - 90) * Math.PI) / 180);
    c.scale(k, k);
    c.translate(-px, -py);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.img, 0, 0);
    const upright = (x, y, fn) => {
      const [ix, iy] = this.toImg(x, y);
      c.save();
      c.translate(ix, iy);
      c.scale(1 / k, 1 / k);
      c.rotate(-((yaw - 90) * Math.PI) / 180);
      fn();
      c.restore();
    };
    // bombsites
    for (const [name, box] of Object.entries(MAP.bombsites || {})) {
      upright((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, () => {
        c.font = 'bold 22px system-ui, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillStyle = 'rgba(255, 90, 70, 0.85)';
        c.fillText(name, 0, 0);
      });
    }
    // the bomb
    const T = g.team === 1;
    const bomb = g.roundHud && g.roundHud.bomb;
    if (bomb) {
      if (Math.floor(now / 300) % 2 === 0) upright(bomb.pos[0], bomb.pos[1], () => this.bombIcon(c, '#ff3b30'));
    } else if (T) {
      const items = g.presentation?.nades?.items;
      if (items) for (const it of items.values()) if (it.def && it.def.id === 'c4') upright(it.pos[0], it.pos[1], () => this.bombIcon(c, '#ffb020'));
    }
    // players
    for (const [id, ent] of g.entities) {
      const s = ent.render || ent.latest;
      if (!s || !(s.flags & EFLAG.ALIVE)) continue;
      const mate = s.team === g.team && g.serverMode !== 'deathmatch';
      const seen = (this.spotted.get(id) || 0) > now;
      if (!mate && !seen) continue;
      upright(s.pos[0], s.pos[1], () => {
        c.beginPath();
        c.arc(0, 0, 4.5, 0, Math.PI * 2);
        c.fillStyle = mate ? (TEAM_COLOR[s.team] || '#ccc') : '#ff3b30';
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = 'rgba(0,0,0,0.7)';
        c.stroke();
        if (mate && T && (s.wflags & 8)) { c.strokeStyle = '#ffb020'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 7.5, 0, Math.PI * 2); c.stroke(); }
        if (id === g.spectating) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(0, 0, 9, 0, Math.PI * 2); c.stroke(); }
      });
    }
    c.restore();
    // us: an arrow in the middle pointing up
    if (g.alive) {
      c.save();
      c.translate(SIZE / 2, SIZE / 2);
      c.beginPath();
      c.moveTo(0, -8); c.lineTo(6, 6); c.lineTo(0, 3); c.lineTo(-6, 6); c.closePath();
      c.fillStyle = '#ffffff';
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = 'rgba(0,0,0,0.8)';
      c.stroke();
      c.restore();
    }
    c.beginPath();
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.stroke();

    // carrying the bomb inside a site: tell them how to plant
    let hint = '';
    if (g.alive && g.ws.c4 && (g.serverMode === 'defusal' || g.serverMode === 'casual')) {
      for (const [name, box] of Object.entries(MAP.bombsites || {})) {
        if (inBox(g.pred.pos, box)) hint = `Bombsite ${name}: press 5 for the bomb, then hold left click to plant`;
      }
    }
    this.setHint(hint);
  }

  bombIcon(c, color) {
    c.fillStyle = color;
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.rect(-6, -4.5, 12, 9);
    c.fill();
    c.stroke();
    c.fillStyle = '#111';
    c.fillRect(-3.5, -2, 4, 2.5);
  }

  /** Enemies in front of us with nothing in the way show up on the radar. */
  spot(eye, yaw) {
    const g = this.game;
    const fx = Math.cos((yaw * Math.PI) / 180), fy = Math.sin((yaw * Math.PI) / 180);
    for (const [id, ent] of g.entities) {
      const s = ent.render || ent.latest;
      if (!s || !(s.flags & EFLAG.ALIVE) || (s.team === g.team && g.serverMode !== 'deathmatch')) continue;
      const tx = s.pos[0] - eye[0], ty = s.pos[1] - eye[1];
      const dist = Math.hypot(tx, ty);
      if (dist > 4000 || (tx * fx + ty * fy) / (dist || 1) < 0.5) continue; // roughly in view (120°)
      g.world.traceRay(eye, [s.pos[0], s.pos[1], s.pos[2] + 50], this.tr);
      if (!this.tr.hit || this.tr.fraction > 0.995) this.spotted.set(id, performance.now() + 1200);
    }
  }

  setHint(text) {
    if (this.hint.textContent !== text) this.hint.textContent = text;
    this.hint.classList.toggle('hidden', !text);
  }
}
