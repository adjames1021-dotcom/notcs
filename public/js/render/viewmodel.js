// ---------------------------------------------------------------------------
// viewmodel.js — your first-person weapon: placement, bob, sway, recoil
// kick, reload/deploy/knife animations and the muzzle flash.
// Drawn in its own scene so it never pokes through walls.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';
import { WEAPON_MODELS, VIEWMODEL_DEFAULTS } from '../../config/models.js';
import { flashTexture } from './effects.js';

const DEG = Math.PI / 180;

export class Viewmodel {
  constructor(renderer, models) {
    this.renderer = renderer;
    this.models = models;
    const cam = renderer.viewCamera;
    cam.position.set(0, 0, 0);
    cam.up.set(0, 0, 1);
    cam.lookAt(1, 0, 0);
    this.root = new THREE.Group(); // moved by animations
    renderer.viewScene.add(this.root);
    this.current = null; // { id, object, entry }
    this.wantId = null;
    this.kick = 0;
    this.bob = 0;
    this.sway = [0, 0];
    this.swing = 0; // knife swing animation 0..1
    this.swingKind = 'slash';
    this.land = 0;
    this.time = 0;
    // muzzle flash sprite
    const mat = new THREE.SpriteMaterial({ map: flashTexture(), color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.flash = new THREE.Sprite(mat);
    this.flash.visible = false;
    this.flash.scale.set(9, 9, 1);
    this.flashTime = 0;
    this.root.add(this.flash);
  }

  setWeapon(def) {
    const id = def ? modelIdFor(def) : null;
    if (id === this.wantId) return;
    this.wantId = id;
    if (this.current) { this.root.remove(this.current.object); this.current = null; }
    if (!def) return;
    this.models.load(id, def.cls).then(() => {
      if (this.wantId !== id) return;
      const inst = this.models.instance(id);
      if (!inst) return;
      inst.object.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 1; } });
      const cfg = WEAPON_MODELS[id] && WEAPON_MODELS[id].view;
      const view = { ...(VIEWMODEL_DEFAULTS[def.cls] || VIEWMODEL_DEFAULTS.rifle), ...(cfg || {}) };
      // put the gun so its front reaches about the configured distance
      const holder = new THREE.Group();
      holder.add(inst.object);
      inst.object.position.x = -inst.length * 0.1;
      this.root.add(holder);
      this.current = { id, object: holder, entry: inst, view, def };
    });
  }

  /** Called when the player fires (predicted). */
  onShot(def) {
    this.kick = Math.min(1.6, this.kick + (def.cls === 'sniper' ? 1.4 : def.cls === 'pistol' ? 0.9 : 0.6));
    const silenced = false;
    if (!silenced && def.cls !== 'knife') { this.flashTime = 0.035; }
  }

  onKnife(kind) { this.swing = 1; this.swingKind = kind; }
  onLand(speed) { this.land = Math.min(1, speed / 600); }

  /**
   * @param s { dt, speed, onGround, mouseDX, mouseDY, deploy (0..1), reload (0..1|-1),
   *            scoped, silenced, throwing }
   */
  update(s) {
    const dt = s.dt;
    this.time += dt;
    this.root.visible = !s.scoped && !!this.current;
    if (!this.current) return;
    const v = this.current.view;
    // walking bob
    const speedFrac = s.onGround ? Math.min(1, s.speed / 250) : 0;
    this.bob += dt * (4 + s.speed * 0.035);
    const bobY = Math.cos(this.bob) * 0.45 * speedFrac;
    const bobZ = Math.abs(Math.sin(this.bob)) * -0.45 * speedFrac;
    // sway: the gun lags behind your mouse a little
    this.sway[0] += (-s.mouseDX * 0.04 - this.sway[0]) * Math.min(1, dt * 12);
    this.sway[1] += (s.mouseDY * 0.04 - this.sway[1]) * Math.min(1, dt * 12);
    this.sway[0] = Math.max(-2, Math.min(2, this.sway[0]));
    this.sway[1] = Math.max(-2, Math.min(2, this.sway[1]));
    // recoil kick decays quickly
    this.kick *= Math.exp(-dt * 14);
    this.land *= Math.exp(-dt * 8);
    // deploy: comes up from below
    const dep = 1 - easeOut(Math.max(0, Math.min(1, s.deploy)));
    // reload: dips and rolls
    const rl = s.reload >= 0 ? Math.sin(Math.PI * Math.min(1, s.reload)) : 0;
    // knife swing
    let swingYaw = 0, swingPitch = 0, swingRoll = 0, swingX = 0;
    if (this.swing > 0) {
      this.swing = Math.max(0, this.swing - dt * (this.swingKind === 'stab' ? 2.2 : 3.5));
      const p = 1 - this.swing;
      const a = Math.sin(p * Math.PI);
      if (this.swingKind === 'stab') { swingX = a * 10; swingPitch = -a * 15; }
      else { swingYaw = (p - 0.5) * 90 * a; swingRoll = a * 40; swingX = a * 4; }
    }
    const pos = v.pos, rot = v.rot;
    // grenade: pin pulled = arm drawn back and up
    this.windup = (this.windup || 0) + ((s.throwing ? 1 : 0) - (this.windup || 0)) * Math.min(1, dt * 10);
    const x = pos[0] - this.kick * 1.4 + swingX - this.windup * 4;
    const y = pos[1] + bobY + this.sway[0] * 0.6 + this.windup * 1.5;
    const z = pos[2] + bobZ - dep * 10 - rl * 4 - this.land * 1.5 + this.sway[1] * 0.5 + this.windup * 3;
    const o = this.current.object;
    o.position.set(x, y, z);
    o.rotation.set(0, 0, 0);
    // Euler: yaw around Z, pitch around Y, roll around X (Hammer axes)
    o.rotateZ((rot[1] + this.sway[0] * 2 + swingYaw) * DEG);
    o.rotateY((rot[0] - this.kick * 4 + dep * 45 + rl * 12 + swingPitch) * DEG);
    o.rotateX((rot[2] + rl * 30 + swingRoll) * DEG);
    // muzzle flash at the barrel tip
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const m = this.current.entry.muzzle;
      const p = new THREE.Vector3(m[0] - this.current.entry.length * 0.1 + 1.5, m[1], m[2]);
      p.applyMatrix4(o.matrix);
      this.flash.position.copy(p);
      this.flash.material.rotation = Math.random() * Math.PI;
      const sz = 6 + Math.random() * 5;
      this.flash.scale.set(sz, sz, 1);
      this.flash.visible = !s.silenced;
    } else this.flash.visible = false;
  }
}

function easeOut(t) { return 1 - (1 - t) * (1 - t); }

/** Which model file a weapon uses (knives depend on team in CS2). */
export function modelIdFor(def) {
  return def.id;
}
