// ---------------------------------------------------------------------------
// players.js — draws the OTHER players.
// Until real player models are added (models/players/, see config/models.js)
// everyone is a simple blocky soldier in team colours whose proportions
// match the hitboxes the server uses.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';
import { EFLAG } from '../../shared/protocol.js';

const TEAM_COLORS = {
  1: { body: 0x9c7a4d, legs: 0x5c4a32, head: 0x3a3028, accent: 0xd8b878 }, // T
  2: { body: 0x34507a, legs: 0x26324a, head: 0x2a2f38, accent: 0x7fb0ff }, // CT
  0: { body: 0x777777, legs: 0x555555, head: 0x444444, accent: 0xaaaaaa },
  3: { body: 0x777777, legs: 0x555555, head: 0x444444, accent: 0xaaaaaa },
};

function box(w, d, h, color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  m.castShadow = true;
  return m;
}

export class PlayerViews {
  constructor(renderer, models) {
    this.renderer = renderer;
    this.models = models; // model loader (weapons in hands), optional
    this.views = new Map();
  }

  create(team) {
    const c = TEAM_COLORS[team] || TEAM_COLORS[0];
    const root = new THREE.Group();
    const body = new THREE.Group(); // rotates with yaw
    root.add(body);
    const legL = box(10, 10, 36, c.legs); legL.position.set(0, 6, 18);
    const legR = box(10, 10, 36, c.legs); legR.position.set(0, -6, 18);
    const hips = new THREE.Group(); hips.position.set(0, 0, 36);
    const torso = box(14, 26, 24, c.body); torso.position.set(0, 0, 12);
    const vest = box(15, 22, 14, c.accent); vest.position.set(0.5, 0, 14);
    const head = box(11, 10, 12, c.head); head.position.set(1, 0, 30);
    const armL = box(8, 7, 24, c.body); armL.position.set(4, 15, 12);
    const armR = box(8, 7, 24, c.body); armR.position.set(4, -15, 12);
    const gun = box(30, 3, 5, 0x222222); gun.position.set(18, -6, 16);
    hips.add(torso, vest, head, armL, armR, gun);
    body.add(legL, legR, hips);
    root.userData = { body, legL, legR, hips, head, gun, team, walk: 0, deadT: 0 };
    this.renderer.scene.add(root);
    return root;
  }

  update(id, s, info, dt) {
    let v = this.views.get(id);
    const alive = !!(s.flags & EFLAG.ALIVE);
    if (!v || v.userData.team !== s.team) {
      if (v) this.renderer.scene.remove(v);
      v = this.create(s.team);
      this.views.set(id, v);
    }
    const u = v.userData;
    v.position.set(s.pos[0], s.pos[1], s.pos[2]);
    u.body.rotation.z = (s.yaw * Math.PI) / 180;
    // crouch: shorten legs, lower upper body
    const duck = s.duck;
    const legH = 36 - 18 * duck;
    u.legL.scale.z = legH / 36; u.legL.position.z = legH / 2;
    u.legR.scale.z = legH / 36; u.legR.position.z = legH / 2;
    u.hips.position.z = legH;
    // aim pitch tilts the upper body a little
    u.hips.rotation.y = (s.pitch * Math.PI) / 180 * 0.35;
    // walking animation from horizontal speed
    const speed = Math.hypot(s.vel[0], s.vel[1]);
    u.walk += dt * speed * 0.05;
    const swing = Math.min(1, speed / 250) * 0.6 * Math.sin(u.walk);
    u.legL.rotation.y = swing;
    u.legR.rotation.y = -swing;
    // dead: fall over and sink after a while
    if (!alive) {
      u.deadT += dt;
      u.body.rotation.y = Math.min(Math.PI / 2, u.deadT * 5);
      v.visible = u.deadT < 8;
    } else {
      u.deadT = 0;
      u.body.rotation.y = 0;
      v.visible = true;
    }
    void info;
  }

  remove(id) {
    const v = this.views.get(id);
    if (v) this.renderer.scene.remove(v);
    this.views.delete(id);
  }
}
