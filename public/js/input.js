// ---------------------------------------------------------------------------
// input.js — keyboard + mouse. Mouse look is applied instantly every frame;
// buttons are sampled once per 64-tick command. A key tapped between two
// ticks still counts (latched), so quick taps are never lost.
// ---------------------------------------------------------------------------

import { IN, IMPULSE } from '../shared/usercmd.js';
import { mouseToDegrees } from './settings.js';

const ACTION_BUTTON = {
  forward: IN.FORWARD,
  back: IN.BACK,
  left: IN.MOVELEFT,
  right: IN.MOVERIGHT,
  jump: IN.JUMP,
  duck: IN.DUCK,
  walk: IN.WALK,
  use: IN.USE,
  reload: IN.RELOAD,
  inspect: IN.INSPECT,
  score: IN.SCORE,
};

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.held = 0; // buttons currently held
    this.latched = 0; // buttons pressed since the last tick
    this.mouseButtons = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.enabled = true; // false while typing in chat / menus
    this.impulses = []; // one-shot actions waiting for the next tick
    this.select = 0; // weapon slot requested
    this.wheelJumpTicks = 0;
    this.zoomFovRatio = 1;
    this.menuCapture = false;
    this.listeners = {}; // action -> callbacks (UI keys like buy menu)
    this.codeToAction = new Map();
    this.rebuildBinds();
    this.install();
  }

  rebuildBinds() {
    this.codeToAction.clear();
    for (const [action, codes] of Object.entries(this.settings.binds)) {
      for (const code of codes) this.codeToAction.set(code, action);
    }
  }

  on(action, fn) {
    (this.listeners[action] || (this.listeners[action] = [])).push(fn);
  }

  fire(action, down, e) {
    for (const fn of this.listeners[action] || []) fn(down, e);
  }

  install() {
    window.addEventListener('keydown', (e) => {
      const action = this.codeToAction.get(e.code);
      // Stop the browser doing its own thing (Tab focus, Ctrl+S, F3 find...)
      if (this.locked && (action || e.ctrlKey)) e.preventDefault();
      if (!action) return;
      if (e.repeat) { if (this.locked) e.preventDefault(); return; }
      if (!this.enabled && action !== 'debug') return;
      const bit = ACTION_BUTTON[action];
      if (bit) { this.held |= bit; this.latched |= bit; }
      if (this.menuCapture && action.startsWith('slot')) return; // buy menu uses the numbers
      if (action === 'lastWeapon') this.impulses.push(IMPULSE.LAST_WEAPON);
      if (action === 'drop') this.impulses.push(IMPULSE.DROP);
      if (action.startsWith('slot')) this.select = Number(action.slice(4));
      this.fire(action, true, e);
    });
    window.addEventListener('keyup', (e) => {
      const action = this.codeToAction.get(e.code);
      if (!action) return;
      const bit = ACTION_BUTTON[action];
      if (bit) this.held &= ~bit;
      this.fire(action, false, e);
    });
    window.addEventListener('blur', () => { this.held = 0; this.mouseButtons = 0; });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      if (e.button === 0) { this.held |= IN.ATTACK; this.latched |= IN.ATTACK; }
      if (e.button === 2) { this.held |= IN.ATTACK2; this.latched |= IN.ATTACK2; }
      this.fire('mouse' + e.button, true, e);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held &= ~IN.ATTACK;
      if (e.button === 2) this.held &= ~IN.ATTACK2;
      this.fire('mouse' + e.button, false, e);
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (!this.locked || !this.enabled) return;
      if (this.settings.wheelJump && e.deltaY > 0) {
        this.latched |= IN.JUMP; // one-tick jump press (scroll bhop)
        return;
      }
      this.impulses.push(e.deltaY > 0 ? IMPULSE.NEXT_WEAPON : IMPULSE.PREV_WEAPON);
    }, { passive: true });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      const d = mouseToDegrees(this.settings, e.movementX, e.movementY, this.zoomFovRatio);
      this.yaw += d.yaw;
      this.pitch = Math.max(-89, Math.min(89, this.pitch + d.pitch));
      // keep yaw in a sane range
      if (this.yaw > 360 || this.yaw < -360) this.yaw %= 360;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.held = 0; this.mouseButtons = 0; }
      this.fire('lock', this.locked);
    });
  }

  async lock() {
    try {
      // unadjustedMovement = raw input, no OS mouse acceleration (like CS2's raw input)
      if (this.settings.rawInput) await this.canvas.requestPointerLock({ unadjustedMovement: true });
      else await this.canvas.requestPointerLock();
    } catch {
      try { await this.canvas.requestPointerLock(); } catch { /* user must click again */ }
    }
    // In fullscreen, Chrome lets games capture Ctrl+W etc. so crouch-walking
    // doesn't close the tab.
    try { if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(); } catch { /* not supported */ }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called once per tick: the buttons for this command. */
  sampleButtons() {
    let b = this.enabled ? (this.held | this.latched) : 0;
    this.latched = 0;
    return b;
  }

  takeImpulse() {
    return this.impulses.length ? this.impulses.shift() : 0;
  }

  takeSelect() {
    const s = this.select;
    this.select = 0;
    return s;
  }
}
