// ---------------------------------------------------------------------------
// nades.js — draws grenades in flight, explosions, smoke clouds (one draw
// call per cloud), fire, the flashbang white-out, and dropped weapons.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';
import { SMOKE_VOXEL } from '../../shared/grenades.js';
import { stepItem } from '../../shared/items.js';
import { WEAPONS, weaponByIndex } from '../../shared/weapons.js';
import { TICK_DT } from '../../shared/constants.js';

const NADE_COLORS = { he: 0x3e4a32, flash: 0x9aa0a8, smoke: 0x55606a, molotov: 0x8a5a2a, incendiary: 0x6a6a7a, decoy: 0x6a5a3a };

// Billboarded, instanced quads: one draw call for a whole smoke cloud / fire.
function billboardMaterial({ color, additive = false, fire = false }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      attribute vec4 aData; // x: appear time, y: size, z: seed, w: unused
      uniform float uTime;
      varying vec2 vUv; varying float vAlpha; varying float vSeed;
      void main() {
        vUv = uv; vSeed = aData.z;
        vec3 center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float grow = smoothstep(aData.x, aData.x + 0.35, uTime);
        vAlpha = grow;
        float size = aData.y * (0.55 + 0.45 * grow);
        ${fire ? 'size *= 0.85 + 0.25 * sin(uTime * 13.0 + aData.z * 40.0); center.z += size * 0.35;' : 'center.z += sin(uTime * 0.6 + aData.z * 20.0) * 1.5;'}
        vec4 mv = modelViewMatrix * vec4(center, 1.0);
        float a = aData.z * 6.2831 + uTime * ${fire ? '0.0' : '0.05'};
        vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * position.xy;
        mv.xy += p * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uFade; uniform float uTime;
      varying vec2 vUv; varying float vAlpha; varying float vSeed;
      void main() {
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;
        ${fire
    ? `float flick = 0.7 + 0.3 * sin(uTime * 20.0 + vSeed * 50.0);
        float a = (1.0 - smoothstep(0.2, 1.0, r)) * vAlpha * uFade * flick;
        vec3 c = mix(vec3(1.0, 0.85, 0.35), uColor, smoothstep(0.0, 0.8, r));
        gl_FragColor = vec4(c * a, a);`
    : `float n = 0.85 + 0.15 * sin((vUv.x + vSeed) * 17.0) * sin((vUv.y - vSeed) * 13.0);
        float a = (1.0 - smoothstep(0.45, 1.0, r)) * vAlpha * uFade * 0.92 * n;
        gl_FragColor = vec4(uColor * (0.9 + 0.1 * vSeed), a);`}
      }`,
  });
}

function makeCloud(points, sizes, appears, color, opts) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const n = points.length / 3;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = appears[i];
    data[i * 4 + 1] = sizes[i];
    data[i * 4 + 2] = ((i * 2654435761) % 1000) / 1000;
  }
  geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
  const mat = billboardMaterial({ color, ...opts });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    mesh.setMatrixAt(i, m);
  }
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

export class NadeView {
  constructor(game, renderer, effects, models) {
    this.game = game;
    this.renderer = renderer;
    this.effects = effects;
    this.models = models;
    this.projectiles = new Map(); // id -> { mesh, buffer:[{tick,pos}] }
    this.smokes = new Map();
    this.fires = new Map();
    this.items = new Map();
    this.booms = [];
    this.shake = 0;
    this.flashEl = document.getElementById('flash-overlay');
    this.flash = { t: 0, hold: 0, total: 0, alpha: 0 };
    this.itemAcc = 0;
    // fireball sprite for HE
    const tex = makeGlowTexture();
    this.boomMat = new THREE.SpriteMaterial({ map: tex, color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });

    game.readWorldExtra = (r, tick) => this.readProjectiles(r, tick);
    game.on('event', (ev) => this.onEvent(ev));
    game.on('welcome', (msg) => this.onWelcome(msg));
  }

  onWelcome(msg) {
    const st = msg.state || {};
    for (const s of st.smokes || []) this.addSmoke({ nade: s.nade, origin: s.origin, voxels: s.voxels, duration: s.left }, true);
    for (const f of st.fires || []) this.addFire({ nade: f.nade, kind: f.kind, cells: f.cells, duration: f.left }, true);
    for (const it of st.items || []) this.addItem({ item: it.item, weapon: it.weapon, pos: it.pos, vel: it.vel, resting: true });
  }

  readProjectiles(r, tick) {
    if (r.remaining < 1) return;
    const n = r.u8();
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const id = r.u16(), widx = r.u8();
      const pos = [r.f32(), r.f32(), r.f32()];
      seen.add(id);
      let pr = this.projectiles.get(id);
      if (!pr) {
        const def = weaponByIndex(widx);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), new THREE.MeshStandardMaterial({ color: NADE_COLORS[def?.id] || 0x555555, roughness: 0.5 }));
        mesh.castShadow = true;
        this.renderer.scene.add(mesh);
        pr = { mesh, buffer: [] };
        this.projectiles.set(id, pr);
      }
      pr.buffer.push({ tick, pos });
      if (pr.buffer.length > 32) pr.buffer.shift();
    }
    for (const [id, pr] of this.projectiles) {
      if (!seen.has(id)) { this.renderer.scene.remove(pr.mesh); this.projectiles.delete(id); }
    }
  }

  onEvent(ev) {
    const g = this.game;
    const a = g.audio;
    switch (ev.type) {
      case 'throw': a.noiseBurst({ pos: ev.pos, gain: 0.2, duration: 0.15, filter: 'bandpass', freq: 900 }); break;
      case 'bounce': a.tone({ pos: ev.pos, gain: 0.25, freq: 1400 + Math.random() * 600, duration: 0.06, type: 'triangle' }); break;
      case 'boom': this.boom(ev); break;
      case 'flashed': if (ev.id === g.localId) this.startFlash(ev); break;
      case 'smoke': this.addSmoke(ev); a.noiseBurst({ pos: ev.origin, gain: 0.5, duration: 1.4, filter: 'highpass', freq: 1800 }); break;
      case 'fire': this.addFire(ev); break;
      case 'extinguish': this.updateFireCells(ev); a.noiseBurst({ pos: ev.cells[0] || null, gain: 0.4, duration: 0.8, filter: 'highpass', freq: 2500 }); break;
      case 'decoyShot': {
        const def = WEAPONS[ev.weapon] || WEAPONS.usps;
        for (let i = 0; i < ev.count; i++) setTimeout(() => a.gunshot(def, ev.pos), i * def.cycle * 1000);
        break;
      }
      case 'item': this.addItem(ev); break;
      case 'itemGone': this.removeItem(ev.item); break;
      case 'pickup': a.tone({ gain: 0.2, freq: 900, freqEnd: 1300, duration: 0.08, type: 'triangle' }); break;
      default: break;
    }
  }

  boom(ev) {
    const g = this.game;
    const pos = ev.pos;
    if (ev.kind === 'he') {
      g.audio.noiseBurst({ pos, gain: 1.0, duration: 0.9, filter: 'lowpass', freq: 500, q: 0.6 });
      g.audio.tone({ pos, gain: 0.6, freq: 70, freqEnd: 30, duration: 0.7 });
      this.sprite(pos, 0xffb060, 30, 220, 0.45, true);
      for (let i = 0; i < 6; i++) this.sprite([pos[0] + (Math.random() - 0.5) * 60, pos[1] + (Math.random() - 0.5) * 60, pos[2] + Math.random() * 50], 0x6a6258, 40, 160, 1.6, false);
      this.effects.light.position.set(pos[0], pos[1], pos[2] + 20);
      this.effects.light.intensity = 3e6;
      this.effects.lightT = 0.12;
      this.addShake(pos, 1.0);
      this.clearSmokeNear(pos, 200);
    } else if (ev.kind === 'flash') {
      g.audio.noiseBurst({ pos, gain: 0.9, duration: 0.35, filter: 'highpass', freq: 900 });
      this.sprite(pos, 0xffffff, 20, 160, 0.25, true);
      this.effects.light.position.set(pos[0], pos[1], pos[2] + 10);
      this.effects.light.intensity = 6e6;
      this.effects.lightT = 0.08;
    } else if (ev.kind === 'airburst' || ev.kind === 'fizzle') {
      g.audio.noiseBurst({ pos, gain: 0.5, duration: 0.5, filter: 'bandpass', freq: 600 });
      this.sprite(pos, ev.kind === 'fizzle' ? 0xaaaaaa : 0xff8030, 10, 80, 0.4, ev.kind !== 'fizzle');
    } else if (ev.kind === 'decoy') {
      g.audio.noiseBurst({ pos, gain: 0.4, duration: 0.3, filter: 'lowpass', freq: 800 });
      this.sprite(pos, 0xffa040, 8, 60, 0.3, true);
    }
  }

  sprite(pos, color, size0, size1, life, additive) {
    const mat = this.boomMat.clone();
    mat.color.set(color);
    mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const s = new THREE.Sprite(mat);
    s.position.set(pos[0], pos[1], pos[2]);
    s.scale.set(size0, size0, 1);
    this.renderer.scene.add(s);
    this.booms.push({ s, t: 0, life, size0, size1 });
  }

  addShake(pos, strength) {
    const e = this.game.viewEye || pos;
    const d = Math.hypot(e[0] - pos[0], e[1] - pos[1], e[2] - pos[2]);
    if (d < 700) this.shake = Math.max(this.shake, strength * (1 - d / 700));
  }

  startFlash(ev) {
    this.flash = { t: 0, hold: ev.hold, total: ev.duration, alpha: ev.alpha };
    if (ev.duration > 1.5) {
      this.game.audio.tone({ gain: 0.18 * Math.min(1, ev.duration / 4), freq: 3200, duration: Math.min(4, ev.duration), type: 'sine' });
    }
  }

  addSmoke(ev, instant = false) {
    const pts = [], sizes = [], appears = [];
    const v = ev.voxels;
    const n = v.length / 3;
    for (let i = 0; i < n; i++) {
      pts.push(ev.origin[0] + v[i * 3] * SMOKE_VOXEL, ev.origin[1] + v[i * 3 + 1] * SMOKE_VOXEL, ev.origin[2] + v[i * 3 + 2] * SMOKE_VOXEL);
      sizes.push(SMOKE_VOXEL * 3.2);
      appears.push(instant ? -1 : (i / n) * 1.1);
    }
    const mesh = makeCloud(pts, sizes, appears, 0xcfd1cf, {});
    this.renderer.scene.add(mesh);
    const set = new Set();
    for (let i = 0; i < v.length; i += 3) set.add(v[i] + ',' + v[i + 1] + ',' + v[i + 2]);
    this.smokes.set(ev.nade, { mesh, t: 0, duration: ev.duration, origin: ev.origin, pts });
  }

  /** CS2: an HE blows a temporary hole in smoke. */
  clearSmokeNear(pos, radius) {
    for (const s of this.smokes.values()) {
      const m = new THREE.Matrix4();
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < s.pts.length / 3; i++) {
        const d = Math.hypot(s.pts[i * 3] - pos[0], s.pts[i * 3 + 1] - pos[1], s.pts[i * 3 + 2] - pos[2]);
        if (d < radius) s.mesh.setMatrixAt(i, zero);
      }
      s.mesh.instanceMatrix.needsUpdate = true;
      // refill after 2 seconds
      setTimeout(() => {
        for (let i = 0; i < s.pts.length / 3; i++) { m.makeTranslation(s.pts[i * 3], s.pts[i * 3 + 1], s.pts[i * 3 + 2]); s.mesh.setMatrixAt(i, m); }
        s.mesh.instanceMatrix.needsUpdate = true;
      }, 2000);
    }
  }

  addFire(ev, instant = false) {
    const pts = [], sizes = [], appears = [];
    for (const c of ev.cells) {
      for (let k = 0; k < 2; k++) {
        pts.push(c[0] + (k ? 7 : -5), c[1] + (k ? -4 : 6), c[2] + 2);
        sizes.push(26 + k * 8);
        appears.push(instant ? -1 : c[3] * 0.06);
      }
    }
    const old = this.fires.get(ev.nade);
    if (old) this.renderer.scene.remove(old.mesh);
    const mesh = makeCloud(pts, sizes, appears, 0xff4a10, { additive: true, fire: true });
    this.renderer.scene.add(mesh);
    this.fires.set(ev.nade, { mesh, t: old ? old.t : 0, duration: old ? old.duration : ev.duration, kind: ev.kind, cells: ev.cells, crackle: 0 });
  }

  updateFireCells(ev) {
    const f = this.fires.get(ev.fire);
    if (!f) return;
    if (!ev.cells.length) { this.renderer.scene.remove(f.mesh); this.fires.delete(ev.fire); return; }
    this.addFire({ nade: ev.fire, kind: f.kind, cells: ev.cells, duration: f.duration }, true);
  }

  addItem(ev) {
    const def = WEAPONS[ev.weapon];
    if (!def) return;
    const it = { pos: ev.pos.slice(), vel: ev.vel.slice(), resting: !!ev.resting, obj: null, def, spin: Math.random() * Math.PI * 2 };
    this.items.set(ev.item, it);
    this.models.load(def.id, def.cls).then(() => {
      if (!this.items.has(ev.item)) return;
      const inst = this.models.instance(def.id);
      if (!inst) return;
      it.obj = inst.object;
      it.obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.renderer.scene.add(it.obj);
    });
  }

  removeItem(id) {
    const it = this.items.get(id);
    if (it && it.obj) this.renderer.scene.remove(it.obj);
    this.items.delete(id);
  }

  update(dt) {
    const g = this.game;
    // flying grenades: draw 100 ms in the past like players
    const rt = g.renderTick();
    for (const pr of this.projectiles.values()) {
      const b = pr.buffer;
      let p = b[b.length - 1].pos;
      for (let i = b.length - 1; i > 0; i--) {
        if (b[i - 1].tick <= rt) {
          const A = b[i - 1], B = b[i];
          const t = Math.max(0, Math.min(1, (rt - A.tick) / Math.max(1, B.tick - A.tick)));
          p = [A.pos[0] + (B.pos[0] - A.pos[0]) * t, A.pos[1] + (B.pos[1] - A.pos[1]) * t, A.pos[2] + (B.pos[2] - A.pos[2]) * t];
          break;
        }
      }
      pr.mesh.position.set(p[0], p[1], p[2]);
      pr.mesh.rotation.x += dt * 8;
    }
    // dropped weapons: same physics as the server (fixed steps)
    this.itemAcc += dt;
    while (this.itemAcc >= TICK_DT) {
      this.itemAcc -= TICK_DT;
      for (const it of this.items.values()) if (!it.resting) stepItem(g.world, it);
    }
    for (const it of this.items.values()) {
      if (!it.obj) continue;
      it.obj.position.set(it.pos[0], it.pos[1], it.pos[2] + 1.5);
      it.obj.rotation.set(0, 0, it.spin);
      if (!it.resting) it.spin += dt * 6;
    }
    // smoke clouds: 18 s then fade out over 2 s
    for (const [id, s] of this.smokes) {
      s.t += dt;
      s.mesh.material.uniforms.uTime.value = s.t;
      const fade = Math.max(0, Math.min(1, (s.duration - s.t) / 2));
      s.mesh.material.uniforms.uFade.value = fade;
      if (fade <= 0) { this.renderer.scene.remove(s.mesh); this.smokes.delete(id); }
    }
    for (const [id, f] of this.fires) {
      f.t += dt;
      f.mesh.material.uniforms.uTime.value = f.t;
      const fade = Math.max(0, Math.min(1, (f.duration - f.t) / 0.8));
      f.mesh.material.uniforms.uFade.value = fade;
      f.crackle -= dt;
      if (f.crackle <= 0 && f.cells.length) {
        const c = f.cells[Math.floor(Math.random() * f.cells.length)];
        g.audio.noiseBurst({ pos: c, gain: 0.25, duration: 0.25, filter: 'bandpass', freq: 600 + Math.random() * 900, q: 0.8 });
        f.crackle = 0.08 + Math.random() * 0.15;
      }
      if (fade <= 0) { this.renderer.scene.remove(f.mesh); this.fires.delete(id); }
    }
    for (const b of this.booms) {
      b.t += dt;
      const k = Math.min(1, b.t / b.life);
      const sz = b.size0 + (b.size1 - b.size0) * Math.sqrt(k);
      b.s.scale.set(sz, sz, 1);
      b.s.material.opacity = 1 - k;
      if (k >= 1) { this.renderer.scene.remove(b.s); b.done = true; }
    }
    this.booms = this.booms.filter((b) => !b.done);
    // flashbang white-out
    const f = this.flash;
    if (f.total > 0) {
      f.t += dt;
      let a = f.t < f.hold ? 1 : Math.max(0, 1 - (f.t - f.hold) / Math.max(0.01, f.total - f.hold));
      a *= f.alpha;
      if (this.flashEl) this.flashEl.style.opacity = String(a);
      if (f.t >= f.total) { f.total = 0; if (this.flashEl) this.flashEl.style.opacity = '0'; }
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  /** Camera shake offset (degrees) for explosions. */
  shakeAngles() {
    if (this.shake <= 0) return [0, 0];
    const t = performance.now() / 1000;
    return [Math.sin(t * 61) * this.shake * 1.5, Math.sin(t * 47 + 1) * this.shake * 1.5];
  }

  /** Is the camera inside a smoke? (used to grey out the screen a little) */
  cameraInSmoke(eye) {
    for (const s of this.smokes.values()) {
      if (s.t < 0.8) continue;
      const d = Math.hypot(eye[0] - s.origin[0], eye[1] - s.origin[1]);
      if (d < 120 && Math.abs(eye[2] - s.origin[2]) < 90) return true;
    }
    return false;
  }
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
