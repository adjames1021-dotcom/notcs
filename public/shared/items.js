// ---------------------------------------------------------------------------
// items.js — weapons lying on the ground: dropping (G), dropping on death,
// picking up by walking over (if the slot is free) or pressing E (swap).
// The fall/bounce is deterministic, so the browser simulates it too and
// only spawn/remove events are sent.
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE } from './constants.js';
import { stepProjectile } from './grenades.js';
import { WEAPONS } from './weapons.js';
import { giveWeapon, slotWeapon, SLOT, switchTo, removeSlot, angleVectors, eyePos } from './weaponLogic.js';
import { IN } from './usercmd.js';

const ITEM_ELASTICITY = 0.25;
const PICKUP_RADIUS = 40;
const USE_RANGE = 80;
const ITEM_LIFETIME = 120; // seconds (practice); rounds clean up items anyway

export class ItemSystem {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  attach(m) { this.m = m; }

  spawn(weapon, ammo, pos, vel, droppedBy = 0) {
    const m = this.m;
    const it = {
      id: this.nextId++, weapon, clip: ammo.clip, reserve: ammo.reserve, flags: ammo.flags || 0,
      // rounded so the browser (which gets these numbers) simulates the exact same fall
      pos: pos.map(r2), vel: vel.map(r2), resting: false, born: m.tick, droppedBy,
    };
    this.items.push(it);
    m.emit({ type: 'item', item: it.id, weapon, pos: it.pos.map(r2), vel: it.vel.map(r2) });
    return it;
  }

  remove(it) {
    it.gone = true;
    this.m.emit({ type: 'itemGone', item: it.id });
  }

  /** G key: throw your current weapon forward. */
  onDrop(p, item) {
    const { forward } = angleVectors(Math.min(p.pitch, 30), p.yaw);
    const eye = eyePos(p.ps);
    const pos = [eye[0] + forward[0] * 12, eye[1] + forward[1] * 12, eye[2] - 8];
    const vel = [forward[0] * 250 + p.ps.vel[0], forward[1] * 250 + p.ps.vel[1], forward[2] * 250 + 60 + p.ps.vel[2] * 0.5];
    this.spawn(item.id, item, pos, vel, p.id);
    if (item.id === 'c4') this.m.hook('onBombDropped', p);
  }

  /** On death you drop your best gun (and the bomb). */
  onKill(p) {
    const ws = p.ws;
    const drops = [];
    if (ws.pri) drops.push(SLOT.PRIMARY); else if (ws.sec) drops.push(SLOT.SECONDARY);
    if (ws.c4) drops.push(SLOT.C4);
    let i = 0;
    for (const slot of drops) {
      const item = removeSlot(ws, slot);
      if (!item) continue;
      const a = (p.yaw + 60 * i++) * Math.PI / 180;
      const pos = [p.ps.pos[0], p.ps.pos[1], p.ps.pos[2] + 40];
      const vel = [Math.cos(a) * 60 + p.ps.vel[0] * 0.5, Math.sin(a) * 60 + p.ps.vel[1] * 0.5, 80];
      this.spawn(item.id, item, pos, vel, p.id);
    }
  }

  update() {
    const m = this.m;
    for (const it of this.items) {
      if (!it.resting) stepItem(m.world, it);
      if (m.mode === 'practice' && (m.tick - it.born) * TICK_DT > ITEM_LIFETIME) this.remove(it);
    }
    // walking over a gun picks it up if that slot is empty
    for (const p of m.players.values()) {
      if (!p.alive || p.dummy) continue;
      const center = [p.ps.pos[0], p.ps.pos[1], p.ps.pos[2] + 24];
      for (const it of this.items) {
        if (it.gone) continue;
        if (it.droppedBy === p.id && m.tick - it.born < TICK_RATE) continue; // don't instantly re-grab
        const d = Math.hypot(it.pos[0] - center[0], it.pos[1] - center[1], (it.pos[2] - center[2]) * 0.6);
        if (d > PICKUP_RADIUS) continue;
        if (this.canAutoPickup(p, it)) this.give(p, it);
      }
    }
    this.items = this.items.filter((it) => !it.gone);
  }

  canAutoPickup(p, it) {
    const def = WEAPONS[it.weapon];
    if (!def) return false;
    if (def.slot === 'primary') return !p.ws.pri;
    if (def.slot === 'secondary') return !p.ws.sec;
    if (def.slot === 'c4') return this.m.teamName(p) === 'T';
    if (def.slot === 'zeus') return !p.ws.zeus;
    if (def.slot === 'grenade') return true;
    return false;
  }

  give(p, it) {
    const def = WEAPONS[it.weapon];
    const res = giveWeapon(p.ws, it.weapon, { clip: it.clip, reserve: it.reserve, flags: it.flags });
    if (!res.ok) return false;
    this.remove(it);
    this.m.emit({ type: 'pickup', id: p.id, weapon: it.weapon, to: p.id });
    if (res.dropped) {
      const eye = eyePos(p.ps);
      this.spawn(res.dropped.id, res.dropped, [eye[0], eye[1], eye[2] - 20], [p.ps.vel[0], p.ps.vel[1], 60], p.id);
    }
    if (def.slot === 'c4') this.m.hook('onBombPickedUp', p);
    return true;
  }

  /** E key: swap with the gun you're looking at. */
  weaponOutput(p, cmd, out) {
    void out;
    const use = !!(cmd.buttons & IN.USE);
    const pressed = use && !p.useHeld;
    p.useHeld = use;
    if (!pressed) return;
    const eye = eyePos(p.ps);
    const { forward } = angleVectors(cmd.pitch, cmd.yaw);
    let best = null, bestDot = 0.9;
    for (const it of this.items) {
      if (it.gone) continue;
      const to = [it.pos[0] - eye[0], it.pos[1] - eye[1], it.pos[2] - eye[2]];
      const d = Math.hypot(to[0], to[1], to[2]);
      if (d > USE_RANGE) continue;
      const dot = (to[0] * forward[0] + to[1] * forward[1] + to[2] * forward[2]) / d;
      if (dot > bestDot) { bestDot = dot; best = it; }
    }
    if (!best) return;
    const def = WEAPONS[best.weapon];
    if (def.slot === 'c4' && this.m.teamName(p) !== 'T') return;
    if (this.give(p, best) && (def.slot === 'primary' || def.slot === 'secondary')) {
      switchTo(p.ws, def.slot === 'primary' ? SLOT.PRIMARY : SLOT.SECONDARY);
    }
  }

  publicState() {
    return { items: this.items.map((it) => ({ item: it.id, weapon: it.weapon, pos: it.pos.map(r2), vel: [0, 0, 0], resting: it.resting })) };
  }

  clear() {
    for (const it of this.items) this.remove(it);
    this.items = [];
  }

  // helper used by round rules: does anyone hold / is there a dropped bomb
  find(weapon) { return this.items.find((it) => it.weapon === weapon && !it.gone) || null; }
}

/** Shared by server and client so a dropped gun lands in the same place. */
export function stepItem(world, it) {
  stepProjectile(world, it, TICK_DT, ITEM_ELASTICITY, null);
  if (it.bounces > 0 && !it.resting) {
    // guns slide to a stop quickly on the floor
    it.vel[0] *= 0.92; it.vel[1] *= 0.92;
  }
}

function r2(v) { return Math.round(v * 100) / 100; }
export { slotWeapon };
