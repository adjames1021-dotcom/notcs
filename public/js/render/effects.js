// ---------------------------------------------------------------------------
// effects.js — tracers, bullet holes, dust and blood puffs, muzzle flashes.
// Everything is pooled (reused) so shooting never stutters.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';

let _flashTex = null, _puffTex = null, _holeTex = null;

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function flashTexture() {
  if (_flashTex) return _flashTex;
  _flashTex = canvasTexture(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,230,1)');
    grd.addColorStop(0.25, 'rgba(255,200,90,0.9)');
    grd.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = grd;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, r = i % 2 ? s * 0.18 : s * 0.5;
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
    }
    g.fill();
  });
  return _flashTex;
}

function puffTexture() {
  if (_puffTex) return _puffTex;
  _puffTex = canvasTexture(64, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  return _puffTex;
}

function holeTexture() {
  if (_holeTex) return _holeTex;
  _holeTex = canvasTexture(32, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(10,8,6,1)');
    grd.addColorStop(0.45, 'rgba(25,20,15,0.85)');
    grd.addColorStop(1, 'rgba(40,30,20,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
  return _holeTex;
}

export class Effects {
  constructor(renderer) {
    this.renderer = renderer;
    const scene = renderer.scene;
    // tracers: thin glowing streaks
    this.tracers = [];
    const tGeo = new THREE.CylinderGeometry(0.22, 0.22, 1, 4, 1, true);
    tGeo.rotateZ(Math.PI / 2); // along +X
    tGeo.translate(0.5, 0, 0);
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, t: 0, life: 0, start: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0 });
    }
    this.tracerIdx = 0;
    // bullet holes
    this.holes = [];
    const hGeo = new THREE.PlaneGeometry(2.2, 2.2);
    const hMat = new THREE.MeshBasicMaterial({ map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    for (let i = 0; i < 160; i++) {
      const m = new THREE.Mesh(hGeo, hMat);
      m.visible = false;
      scene.add(m);
      this.holes.push(m);
    }
    this.holeIdx = 0;
    // puffs (dust, blood, sparks)
    this.puffs = [];
    for (let i = 0; i < 160; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture(), transparent: true, depthWrite: false }));
      s.visible = false;
      scene.add(s);
      this.puffs.push({ sprite: s, t: 0, life: 0, vel: new THREE.Vector3(), grow: 1, size: 1 });
    }
    this.puffIdx = 0;
    // other players' muzzle flashes
    this.flashes = [];
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.visible = false;
      s.scale.set(14, 14, 1);
      scene.add(s);
      this.flashes.push({ sprite: s, t: 0 });
    }
    this.flashIdx = 0;
    // one light that flickers on gunshots (never added/removed: no shader recompiles)
    this.light = new THREE.PointLight(0xffc070, 0, 500, 1.6);
    scene.add(this.light);
    this.lightT = 0;
  }

  tracer(from, to, speed = 9000) {
    const tr = this.tracers[this.tracerIdx++ % this.tracers.length];
    tr.start.set(from[0], from[1], from[2]);
    tr.dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    tr.len = tr.dir.length();
    if (tr.len < 30) return;
    tr.dir.divideScalar(tr.len);
    tr.t = 0;
    tr.life = tr.len / speed;
    tr.mesh.visible = true;
    tr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tr.dir);
  }

  impact(pos, normal, blood = false) {
    if (!blood) {
      const h = this.holes[this.holeIdx++ % this.holes.length];
      h.position.set(pos[0] + normal[0] * 0.15, pos[1] + normal[1] * 0.15, pos[2] + normal[2] * 0.15);
      h.lookAt(h.position.x + normal[0], h.position.y + normal[1], h.position.z + normal[2]);
      h.rotateZ(Math.random() * Math.PI);
      h.visible = true;
    }
    const n = blood ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const p = this.puffs[this.puffIdx++ % this.puffs.length];
      p.sprite.position.set(pos[0], pos[1], pos[2]);
      p.vel.set(normal[0] * 40 + (Math.random() - 0.5) * 40, normal[1] * 40 + (Math.random() - 0.5) * 40, normal[2] * 40 + Math.random() * 30);
      p.t = 0;
      p.life = blood ? 0.35 : 0.5 + Math.random() * 0.3;
      p.size = blood ? 5 : 4;
      p.grow = blood ? 16 : 22;
      p.sprite.material.color.set(blood ? 0x8a0a0a : 0xc8b090);
      p.sprite.material.opacity = blood ? 0.9 : 0.55;
      p.sprite.visible = true;
    }
  }

  muzzleFlash(pos) {
    const f = this.flashes[this.flashIdx++ % this.flashes.length];
    f.sprite.position.set(pos[0], pos[1], pos[2]);
    f.sprite.material.rotation = Math.random() * Math.PI;
    f.t = 0.04;
    f.sprite.visible = true;
    this.light.position.set(pos[0], pos[1], pos[2]);
    this.light.intensity = 400000;
    this.lightT = 0.05;
  }

  update(dt) {
    for (const tr of this.tracers) {
      if (!tr.mesh.visible) continue;
      tr.t += dt;
      if (tr.t >= tr.life) { tr.mesh.visible = false; continue; }
      const segLen = Math.min(tr.len, 90);
      const head = Math.min(tr.len, (tr.t / tr.life) * tr.len + segLen);
      const tail = Math.max(0, head - segLen);
      tr.mesh.position.copy(tr.start).addScaledVector(tr.dir, tail);
      tr.mesh.scale.set(Math.max(1, head - tail), 1, 1);
    }
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.t += dt;
      if (p.t >= p.life) { p.sprite.visible = false; continue; }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-dt * 4));
      const s = p.size + p.grow * p.t;
      p.sprite.scale.set(s, s, 1);
      p.sprite.material.opacity *= Math.exp(-dt * 3);
    }
    for (const f of this.flashes) {
      if (!f.sprite.visible) continue;
      f.t -= dt;
      if (f.t <= 0) f.sprite.visible = false;
    }
    if (this.lightT > 0) {
      this.lightT -= dt;
      if (this.lightT <= 0) this.light.intensity = 0;
    }
  }
}
