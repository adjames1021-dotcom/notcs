// ---------------------------------------------------------------------------
// hud.js — health/armor/money/ammo, timer, net graph, debug overlay (F3).
// Only touches the page when a value actually changes (keeps FPS high).
// ---------------------------------------------------------------------------

import { drawCrosshair } from './crosshair.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(settings) {
    this.settings = settings;
    this.root = $('hud');
    this.el = {
      health: $('hud-health'), armor: $('hud-armor'), money: $('hud-money-value'), moneyBox: $('hud-money'),
      ammo: $('hud-ammo'), reserve: $('hud-reserve'), ammoBox: $('hud-ammo-box'),
      timer: $('hud-timer'), roundMsg: $('hud-round-msg'), center: $('hud-center-msg'),
      debug: $('debug-overlay'), net: $('net-graph'), crosshair: $('crosshair'), weapons: $('hud-weapons'),
    };
    this.cache = {};
    this.debugVisible = false;
    this.crosshairCanvas = document.createElement('canvas');
    this.el.crosshair.appendChild(this.crosshairCanvas);
    this.redrawCrosshair();
    window.addEventListener('resize', () => this.redrawCrosshair());
  }

  show(v) { this.root.classList.toggle('hidden', !v); }

  set(key, el, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.textContent = value;
  }

  setCenter(text) { this.set('center', this.el.center, text || ''); }

  toggleDebug() {
    this.debugVisible = !this.debugVisible;
    this.el.debug.classList.toggle('hidden', !this.debugVisible);
  }

  redrawCrosshair(gapExtra = 0) {
    drawCrosshair(this.crosshairCanvas, this.settings.crosshair, gapExtra);
  }

  update(game) {
    const h = game.hudState;
    this.set('health', this.el.health, String(game.alive ? h.health : 0));
    this.set('armor', this.el.armor, String(h.armor) + (h.helmet ? '+' : ''));
    this.set('money', this.el.money, String(h.money));
    const showCross = game.alive && !game.scoped;
    if (this.cache.cross !== showCross) { this.cache.cross = showCross; this.el.crosshair.style.display = showCross ? '' : 'none'; }
    if (game.updateHud) game.updateHud(this);

    // net graph (top right)
    if (this.settings.showNetGraph) {
      const s = game.stats;
      this.set('net', this.el.net, `${s.fps} fps  ·  ping ${Math.round(game.ping)} ms  ·  tick ${game.serverTick}`);
    } else this.set('net', this.el.net, '');

    if (this.debugVisible) {
      const p = game.pred, s = game.stats;
      const sp = Math.hypot(p.vel[0], p.vel[1]);
      const text =
        `pos   ${p.pos.map((v) => v.toFixed(1)).join('  ')}\n` +
        `vel   ${p.vel.map((v) => v.toFixed(1)).join('  ')}\n` +
        `speed ${sp.toFixed(1)} u/s   ${p.onGround ? 'ON GROUND' : 'in air'}${p.ducked ? '  DUCKED' : ''}\n` +
        `duck  ${p.duckAmount.toFixed(2)}  stamina ${p.stamina.toFixed(1)}  tag ${p.velocityModifier.toFixed(2)}\n` +
        `yaw   ${game.input.yaw.toFixed(2)}  pitch ${game.input.pitch.toFixed(2)}\n` +
        `\n` +
        `fps ${s.fps}   ping ${game.ping.toFixed(1)} ms\n` +
        `server tick ${game.serverTick}   est ${game.serverTickEst.toFixed(1)}\n` +
        `cmd ${game.cmdNum}   ack ${game.lastAck ?? 0}   unacked ${game.history.length}\n` +
        `snapshots ${s.snapRate ?? 0}/s   in ${s.kbIn ?? 0} KB/s   out ${s.msgsOut ?? 0} msg/s\n` +
        `prediction corrections ${s.corrections}   (${s.lastMismatch || "-"})\n` +
        `last error ${s.lastError.toFixed(4)}   max ${s.maxError.toFixed(4)}\n` +
        `players ${game.entities.size + 1}   interp ${Math.round(game.interpDelayMs ?? 100)} ms`;
      this.set('debug', this.el.debug, text);
    }
  }
}
