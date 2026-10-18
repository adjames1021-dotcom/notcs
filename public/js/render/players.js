// ---------------------------------------------------------------------------
// players.js — draws the OTHER players.
//
// Until real player models are added (models/players/, see config/models.js)
// everyone is a low-poly soldier in their team's outfit: Terrorists in a
// brown jacket and black balaclava, Counter-Terrorists in dark blue with a
// plate carrier, helmet and goggles.
//
// The body is built on the same skeleton as the hitboxes (shared/skeleton.js),
// so crouching bends the knees and aiming up/down leans the upper body in
// exactly the way the server checks hits. Walking swings the legs in the
// direction the player is moving; dead players fall over.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';
import { EFLAG } from '../../shared/protocol.js';
import { weaponByIndex } from '../../shared/weapons.js';
import { skeleton } from '../../shared/skeleton.js';

const LOOKS = {
  1: { // Terrorists
    pants: 0x7d6e52, jacket: 0x5b4b36, rig: 0x3f3626, head: 0x1d1c1b, skin: 0xb88d6a,
    gloves: 0x8a7350, boots: 0x2e251c, accent: 0x4a3f2c, helmet: false,
  },
  2: { // Counter-Terrorists
    pants: 0x2b3340, jacket: 0x323b4a, rig: 0x232a35, head: 0xc6987a, skin: 0xc6987a,
    gloves: 0x1a1c20, boots: 0x15171a, accent: 0x3e4a5c, helmet: true,
  },
  0: { pants: 0x666666, jacket: 0x777777, rig: 0x555555, head: 0x444444, skin: 0xaaaaaa, gloves: 0x555555, boots: 0x333333, accent: 0x888888, helmet: false },
};
LOOKS[3] = LOOKS[0];

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

// Shared geometry (built once).
const GEO = {
  sphere: new THREE.SphereGeometry(1, 14, 10),
  box: new THREE.BoxGeometry(1, 1, 1),
};
const cylCache = new Map();
function cyl(rTop, rBottom) {
  const key = rTop + ':' + rBottom;
  if (!cylCache.has(key)) cylCache.set(key, new THREE.CylinderGeometry(rTop, rBottom, 1, 12, 1));
  return cylCache.get(key);
}
const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...opts }));
  return matCache.get(key);
}

function mesh(geo, material, shadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = shadow;
  m.receiveShadow = false;
  return m;
}

/** Stretch a cylinder (axis = Y) between two points a and b. */
function placeLimb(m, a, b) {
  _v.subVectors(b, a);
  const len = _v.length() || 0.001;
  m.position.copy(a).addScaledVector(_v, 0.5);
  m.quaternion.setFromUnitVectors(UP, _v.multiplyScalar(1 / len));
  m.scale.set(1, len, 1);
}

/** Knee position for hip h and ankle a (bends forward, two 16-unit bones). */
function knee(h, a, out) {
  const dx = a[0] - h[0], dy = a[1] - h[1], dz = a[2] - h[2];
  let d = Math.hypot(dx, dy, dz);
  if (d < 0.001) d = 0.001;
  const half = Math.min(16, d / 2);
  const h2 = Math.sqrt(Math.max(0, 16 * 16 - half * half));
  // perpendicular toward "forward" (+X) in the leg's plane
  const ux = dx / d, uy = dy / d, uz = dz / d;
  let px = 1 - ux * ux, py = -ux * uy, pz = -ux * uz;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl; py /= pl; pz /= pl;
  out[0] = h[0] + dx / 2 + px * h2;
  out[1] = h[1] + dy / 2 + py * h2;
  out[2] = h[2] + dz / 2 + pz * h2;
  return out;
}

const V = (arr) => _a.set(arr[0], arr[1], arr[2]);
const W = (arr) => _b.set(arr[0], arr[1], arr[2]);

export class PlayerViews {
  constructor(renderer, models) {
    this.renderer = renderer;
    this.models = models; // model loader (weapons in hands), optional
    this.views = new Map();
  }

  create(team) {
    const L = LOOKS[team] || LOOKS[0];
    const root = new THREE.Group();
    const body = new THREE.Group(); // yaw
    body.rotation.order = 'ZYX';
    root.add(body);
    const P = {};
    const add = (name, m) => { P[name] = m; body.add(m); return m; };
    // legs
    for (const s of ['L', 'R']) {
      add('thigh' + s, mesh(cyl(4.0, 4.6), mat(L.pants)));
      add('shin' + s, mesh(cyl(3.3, 3.9), mat(L.pants)));
      add('knee' + s, mesh(GEO.sphere, mat(team === 2 ? L.rig : L.pants))).scale.setScalar(team === 2 ? 4.2 : 3.9);
      add('boot' + s, mesh(GEO.box, mat(L.boots))).scale.set(11, 5.2, 4.6);
      // arms
      add('shoulder' + s, mesh(GEO.sphere, mat(L.jacket))).scale.setScalar(3.4);
      add('upper' + s, mesh(cyl(2.6, 3.0), mat(L.jacket)));
      add('elbow' + s, mesh(GEO.sphere, mat(L.jacket))).scale.setScalar(2.6);
      add('fore' + s, mesh(cyl(2.2, 2.5), mat(L.jacket)));
      add('hand' + s, mesh(GEO.sphere, mat(L.gloves))).scale.set(2.3, 2.0, 2.3);
    }
    add('pelvis', mesh(GEO.box, mat(L.pants))).scale.set(9, 15, 8);
    add('belt', mesh(GEO.box, mat(L.accent))).scale.set(9.6, 15.6, 2);
    add('torso', mesh(cyl(7.8, 7.0), mat(L.jacket)));
    add('vest', mesh(GEO.box, mat(L.rig)));
    for (let i = 0; i < 3; i++) add('pouch' + i, mesh(GEO.box, mat(L.accent), false)).scale.set(2.6, 3.6, 4.2);
    if (team === 1) add('pack', mesh(GEO.box, mat(L.accent))).scale.set(4.5, 10, 10);
    add('neck', mesh(cyl(2.4, 2.7), mat(team === 2 ? L.skin : L.head)));
    // head (a group so the helmet/goggles tilt with it)
    const head = new THREE.Group();
    body.add(head);
    P.head = head;
    const skull = mesh(GEO.sphere, mat(L.head));
    skull.scale.set(4.5, 4.1, 5.0);
    head.add(skull);
    if (L.helmet) {
      const helmet = mesh(GEO.sphere, mat(0x2b3138, { roughness: 0.6 }));
      helmet.scale.set(5.3, 5.0, 3.9);
      helmet.position.set(-0.4, 0, 1.6);
      head.add(helmet);
      const goggles = mesh(GEO.box, mat(0x0d1014, { roughness: 0.2, metalness: 0.4, emissive: 0x0a1a2a }), false);
      goggles.scale.set(1.6, 7.4, 1.8);
      goggles.position.set(3.9, 0, 1.0);
      head.add(goggles);
    } else {
      // balaclava with an eye opening
      const eyes = mesh(GEO.box, mat(L.skin), false);
      eyes.scale.set(1.2, 5.6, 1.4);
      eyes.position.set(4.2, 0, 0.9);
      head.add(eyes);
    }
    // weapon holder sits in the right hand and points where they aim
    const gunMount = new THREE.Group();
    body.add(gunMount);
    const gun = mesh(GEO.box, mat(0x222222));
    gun.scale.set(28, 2.6, 4.2);
    gun.position.set(6, 0, 1.5);
    gunMount.add(gun);
    P.gunMount = gunMount;
    root.userData = {
      body, P, gun, team, walk: 0, deadT: 0, weapon: -1, weaponObj: null, weaponCls: 'rifle', custom: null,
      joints: {}, fall: 0, fallSide: 1,
    };
    this.renderer.scene.add(root);
    // Real player model (models/players/t.glb or ct.glb) replaces the soldier.
    const teamName = team === 2 ? 'CT' : team === 1 ? 'T' : null;
    if (teamName && this.models) {
      this.models.loadPlayer(teamName).then((entry) => {
        if (!entry || root.userData.team !== team) return;
        const model = this.models.playerInstance(teamName);
        if (!model) return;
        model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        for (const [name, part] of Object.entries(P)) if (name !== 'gunMount') part.visible = false;
        body.add(model);
        root.userData.custom = model;
      });
    }
    return root;
  }

  update(id, s, info, dt) {
    let v = this.views.get(id);
    const alive = !!(s.flags & EFLAG.ALIVE);
    if (!v || v.userData.team !== s.team) {
      if (v) this.renderer.scene.remove(v);
      v = this.create(s.team);
      v.userData.fallSide = id % 2 ? 1 : -1;
      this.views.set(id, v);
    }
    const u = v.userData;
    v.position.set(s.pos[0], s.pos[1], s.pos[2]);
    const yaw = (s.yaw * Math.PI) / 180;
    u.body.rotation.z = yaw;

    // movement relative to where they face
    const c = Math.cos(-yaw), sn = Math.sin(-yaw);
    const vf = s.vel[0] * c - s.vel[1] * sn, vs = s.vel[0] * sn + s.vel[1] * c;
    const speed = Math.hypot(vf, vs);
    const onGround = !!(s.flags & EFLAG.ON_GROUND);
    const amp = Math.min(1, speed / 250) * (1 - 0.45 * s.duck);
    u.walk += dt * speed * 0.105;
    const dirF = speed > 1 ? vf / speed : 0, dirS = speed > 1 ? vs / speed : 0;

    // joints from the shared skeleton (same as the hitboxes)
    const j = skeleton(s.duck, alive ? s.pitch : 0, u.joints);
    // legs: stride in the direction of travel, lift the swinging foot
    for (const [side, ph] of [['L', 0], ['R', Math.PI]]) {
      const ankle = j['ankle' + side];
      const swing = Math.sin(u.walk + ph) * 9 * amp;
      ankle[0] += dirF * swing;
      ankle[1] += dirS * swing;
      ankle[2] += Math.max(0, Math.cos(u.walk + ph)) * 4 * amp;
      if (!onGround && alive) { ankle[2] += 6; ankle[0] -= 3; } // tuck in the air
      knee(j['hip' + side], ankle, j['knee' + side]);
    }
    const bob = onGround ? -Math.abs(Math.sin(u.walk)) * 0.9 * amp : 0;
    this.pose(u, j, bob);

    // dead: fall over, then disappear after a while
    if (!alive) {
      u.deadT += dt;
      u.fall = Math.min(1, u.fall + dt * 3.2);
      const k = 1 - (1 - u.fall) * (1 - u.fall);
      u.body.rotation.y = -k * (Math.PI / 2) * 0.95;
      u.body.rotation.x = u.fallSide * k * 0.25;
      u.body.position.z = k * 5;
      v.visible = u.deadT < 8;
    } else {
      u.deadT = 0;
      u.fall = 0;
      u.body.rotation.y = 0;
      u.body.rotation.x = 0;
      u.body.position.z = 0;
      v.visible = true;
    }
    if (u.custom) u.custom.scale.z = 1 - 0.25 * s.duck;
    this.updateWeapon(v, s.weapon);
    // aim the gun (dead players have dropped theirs)
    u.P.gunMount.visible = alive;
    const pitch = alive ? (s.pitch * Math.PI) / 180 : 0;
    u.P.gunMount.position.set(j.handR[0], j.handR[1], j.handR[2] + bob);
    u.P.gunMount.rotation.set(0, pitch, 0);
    void info;
  }

  /** Put every body part where the joints say. */
  pose(u, j, bob) {
    const P = u.P;
    const up = (k, dz = 0) => [j[k][0], j[k][1], j[k][2] + dz];
    for (const s of ['L', 'R']) {
      placeLimb(P['thigh' + s], V(j['hip' + s]), W(j['knee' + s]));
      placeLimb(P['shin' + s], V(j['knee' + s]), W(j['ankle' + s]));
      P['knee' + s].position.set(j['knee' + s][0] + 0.6, j['knee' + s][1], j['knee' + s][2]);
      P['boot' + s].position.set(j['ankle' + s][0] + 3, j['ankle' + s][1], j['ankle' + s][2] - 1.2);
      placeLimb(P['upper' + s], V(up('shoulder' + s, bob)), W(up('elbow' + s, bob)));
      placeLimb(P['fore' + s], V(up('elbow' + s, bob)), W(up('hand' + s, bob)));
      P['shoulder' + s].position.set(...up('shoulder' + s, bob));
      P['elbow' + s].position.set(...up('elbow' + s, bob));
      P['hand' + s].position.set(...up('hand' + s, bob));
    }
    const hipZ = (j.hipL[2] + j.hipR[2]) / 2;
    P.pelvis.position.set(0, 0, hipZ + 1 + bob);
    P.belt.position.set(0, 0, hipZ + 4.5 + bob);
    // torso from the stomach to the top of the chest, a bit flatter front-to-back
    const lo = up('stomachLow', bob - 1), hi = up('chestHigh', bob + 1.5);
    placeLimb(P.torso, V(lo), W(hi));
    P.torso.scale.x = 0.82;
    P.torso.scale.z = 1.08;
    // vest/chest rig on the chest, tilted with it
    const cx = (j.chestLow[0] + j.chestHigh[0]) / 2, cz = (j.chestLow[2] + j.chestHigh[2]) / 2 + bob;
    const lean = Math.atan2(j.chestHigh[0] - j.stomachLow[0], j.chestHigh[2] - j.stomachLow[2]);
    P.vest.position.set(cx + 0.6, 0, cz - 1);
    P.vest.rotation.set(0, lean, 0);
    P.vest.scale.set(u.team === 2 ? 13.6 : 12.4, u.team === 2 ? 16.4 : 14.8, u.team === 2 ? 14 : 11);
    for (let i = 0; i < 3; i++) {
      P['pouch' + i].position.set(cx + 7.4 * Math.cos(lean) + 0.5, (i - 1) * 4.2, cz - 4.5);
      P['pouch' + i].rotation.set(0, lean, 0);
    }
    if (P.pack) { P.pack.position.set(cx - 7.6, 0, cz); P.pack.rotation.set(0, lean, 0); }
    placeLimb(P.neck, V(up('neckLow', bob)), W(up('neckHigh', bob)));
    // head: centre of the head hitbox, tilted along it
    const h0 = j.headLow, h1 = j.headHigh;
    P.head.position.set((h0[0] + h1[0]) / 2, (h0[1] + h1[1]) / 2, (h0[2] + h1[2]) / 2 + bob);
    P.head.rotation.set(0, Math.atan2(h1[0] - h0[0], h1[2] - h0[2]) - 0.2, 0);
  }

  /** Show the weapon the player is holding (real model once it's loaded). */
  updateWeapon(v, index) {
    const u = v.userData;
    if (u.weapon === index) return;
    u.weapon = index;
    if (u.weaponObj) { u.P.gunMount.remove(u.weaponObj); u.weaponObj = null; }
    const def = weaponByIndex(index);
    u.gun.visible = !def;
    if (!def || !this.models) return;
    this.models.load(def.id, def.cls).then(() => {
      if (u.weapon !== index) return;
      const inst = this.models.instance(def.id);
      if (!inst) return;
      const o = inst.object;
      // the grip sits in the right hand: pistols near their middle, long guns a
      // third of the way back
      const L = inst.length || 20;
      if (def.cls === 'knife') o.position.set(3, 0, 0);
      else if (def.cls === 'pistol' || def.cls === 'zeus') o.position.set(L * 0.15, 0, 2);
      else if (def.cls === 'grenade' || def.cls === 'c4') o.position.set(1, 0, 1);
      else o.position.set(L * 0.18, 1.5, 2.5);
      o.traverse((m) => { if (m.isMesh) m.castShadow = true; });
      u.P.gunMount.add(o);
      u.weaponObj = o;
    });
  }

  remove(id) {
    const v = this.views.get(id);
    if (v) this.renderer.scene.remove(v);
    this.views.delete(id);
  }
}
