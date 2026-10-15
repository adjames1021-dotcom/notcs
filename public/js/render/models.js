// ---------------------------------------------------------------------------
// models.js — loads weapon models listed in config/models.js and turns each
// one into a "normalized" model:
//     barrel along +X, top along +Z, size in Hammer units, centred at 0.
// That way the rest of the game never cares how the file was made.
// If a file is missing or broken you get a placeholder gun instead.
// ---------------------------------------------------------------------------

import { THREE } from './renderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { WEAPON_MODELS, MODEL_DEFAULTS } from '../../config/models.js';

const AXES = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

// Rough real-world lengths (Hammer units) for placeholder guns.
const PLACEHOLDER_SIZE = {
  rifle: 34, sniper: 46, smg: 24, heavy: 40, shotgun: 38, pistol: 9, knife: 12, grenade: 4, c4: 11, zeus: 8,
};

export class ModelLibrary {
  constructor() {
    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.cache = new Map(); // id -> Promise<entry>
    this.ready = new Map(); // id -> entry (once loaded)
    // which model files exist (written by `npm run models`)
    this.manifest = fetch('/models/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  configFor(id) {
    return { ...MODEL_DEFAULTS, file: `/models/weapons/${id}.glb`, ...(WEAPON_MODELS[id] || {}) };
  }

  /** Load (once) and return { object, length, muzzle:[x,y,z], placeholder }. */
  load(id, cls = 'rifle') {
    if (this.cache.has(id)) return this.cache.get(id);
    const cfg = this.configFor(id);
    const custom = WEAPON_MODELS[id] && WEAPON_MODELS[id].file;
    const p = this.manifest
      .then((m) => {
        if (m && !custom && !(m.weapons || []).includes(id)) throw new Error('no model file yet');
        return this.loader.loadAsync(cfg.file);
      })
      .then((gltf) => normalize(gltf.scene, cfg))
      .catch((err) => {
        if (err && err.message !== 'no model file yet') console.warn(`[models] ${id}: ${err.message || err} — using placeholder`);
        return placeholder(id, cls);
      })
      .then((entry) => { this.ready.set(id, entry); return entry; });
    this.cache.set(id, p);
    return p;
  }

  /** A new copy of a loaded model (or null if it isn't loaded yet). */
  instance(id) {
    const e = this.ready.get(id);
    return e ? { object: e.object.clone(true), length: e.length, muzzle: e.muzzle.slice(), placeholder: e.placeholder } : null;
  }
}

/** Bake skinned meshes into plain meshes (they're only posed once). */
function bakeSkinned(root) {
  root.updateMatrixWorld(true);
  const swaps = [];
  root.traverse((o) => { if (o.isSkinnedMesh) swaps.push(o); });
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const m = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  for (const sm of swaps) {
    sm.skeleton.update();
    const g = sm.geometry;
    const pos = g.attributes.position, nor = g.attributes.normal;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const outP = new Float32Array(pos.count * 3);
    const outN = nor ? new Float32Array(pos.count * 3) : null;
    const bones = sm.skeleton.boneMatrices;
    for (let i = 0; i < pos.count; i++) {
      // blended bone matrix
      m.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        tmp.fromArray(bones, si.getComponent(i, k) * 16);
        for (let e = 0; e < 16; e++) m.elements[e] += tmp.elements[e] * w;
      }
      tmp.multiplyMatrices(sm.bindMatrixInverse, m).multiply(sm.bindMatrix);
      tmp.premultiply(sm.matrixWorld);
      v.fromBufferAttribute(pos, i).applyMatrix4(tmp);
      outP[i * 3] = v.x; outP[i * 3 + 1] = v.y; outP[i * 3 + 2] = v.z;
      if (outN) {
        nm.getNormalMatrix(tmp);
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        outN[i * 3] = n.x; outN[i * 3 + 1] = n.y; outN[i * 3 + 2] = n.z;
      }
    }
    const baked = new THREE.BufferGeometry();
    baked.setAttribute('position', new THREE.BufferAttribute(outP, 3));
    if (outN) baked.setAttribute('normal', new THREE.BufferAttribute(outN, 3));
    for (const name of ['uv', 'uv1', 'uv2', 'color']) if (g.attributes[name]) baked.setAttribute(name, g.attributes[name]);
    if (g.index) baked.setIndex(g.index);
    for (const grp of g.groups) baked.addGroup(grp.start, grp.count, grp.materialIndex);
    const mesh = new THREE.Mesh(baked, sm.material);
    mesh.name = sm.name;
    // baked vertices are already in world space: attach at the root
    root.add(mesh);
    sm.parent.remove(sm);
  }
  return swaps.length;
}

function normalize(scene, cfg) {
  const baked = bakeSkinned(scene);
  scene.updateMatrixWorld(true);
  // Collect all mesh vertices in scene space.
  const f = new THREE.Vector3(...AXES[cfg.forward]);
  const u = new THREE.Vector3(...AXES[cfg.up]);
  const l = new THREE.Vector3().crossVectors(u, f); // left
  // rotation: model forward -> +X, left -> +Y, up -> +Z
  const R = new THREE.Matrix4().set(
    f.x, f.y, f.z, 0,
    l.x, l.y, l.z, 0,
    u.x, u.y, u.z, 0,
    0, 0, 0, 1,
  );
  const box = new THREE.Box3().setFromObject(scene, true);
  const size = box.getSize(new THREE.Vector3());
  let scale = cfg.scale;
  if (scale === 'auto' || !scale) scale = Math.max(size.x, size.y, size.z) < 3 ? 39.37 : 1;
  const S = new THREE.Matrix4().makeScale(scale, scale, scale);
  const M = new THREE.Matrix4().multiplyMatrices(S, R);
  // Work out the centre and the muzzle in normalized space.
  const pts = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(p.count / 4000));
    for (let i = 0; i < p.count; i += step) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).applyMatrix4(M);
      pts.push(v.x, v.y, v.z);
    }
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pts[i + c]); max[c] = Math.max(max[c], pts[i + c]); }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const length = max[0] - min[0];
  // muzzle = average of the front-most 3% of points
  let my = 0, mz = 0, mc = 0;
  for (let i = 0; i < pts.length; i += 3) if (pts[i] > max[0] - length * 0.03) { my += pts[i + 1]; mz += pts[i + 2]; mc++; }
  const muzzle = [max[0] - center[0], (mc ? my / mc : center[1]) - center[1], (mc ? mz / mc : center[2]) - center[2]];

  const inner = new THREE.Group();
  inner.matrixAutoUpdate = false;
  const T = new THREE.Matrix4().makeTranslation(-center[0], -center[1], -center[2]);
  inner.matrix.multiplyMatrices(T, M);
  inner.add(scene);
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) if (mat) mat.side = THREE.FrontSide;
    }
  });
  const object = new THREE.Group();
  object.add(inner);
  object.userData.normalized = true;
  return { object, length, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], muzzle, placeholder: false, baked };
}

/** A simple box gun, so missing models never break the game. */
export function placeholder(id, cls) {
  const L = PLACEHOLDER_SIZE[cls] || 30;
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.3 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 0.8 });
  const add = (w, d, h, x, y, z, mat = dark) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.frustumCulled = false;
    g.add(m);
    return m;
  };
  let muzzle = [L / 2, 0, 1];
  if (cls === 'knife') {
    add(L * 0.55, 0.4, 1.4, L * 0.2, 0, 0, new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.3 }));
    add(L * 0.4, 1.2, 1.4, -L * 0.28, 0, 0, accent);
    muzzle = [L / 2, 0, 0];
  } else if (cls === 'grenade') {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8), new THREE.MeshStandardMaterial({ color: id === 'flash' ? 0x9aa0a8 : id === 'smoke' ? 0x55606a : id === 'decoy' ? 0x6a5a3a : (id === 'molotov' || id === 'incendiary') ? 0x8a5a2a : 0x3e4a32, roughness: 0.6 }));
    s.castShadow = true;
    g.add(s);
    add(0.8, 0.8, 1.2, 0, 0, 2.2);
    muzzle = [1.8, 0, 0];
  } else if (cls === 'c4') {
    add(L, 6, 3, 0, 0, 0, new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 0.9 }));
    add(3, 2.4, 0.6, 1, 0, 1.7, new THREE.MeshStandardMaterial({ color: 0x223322, emissive: 0x113311 }));
  } else if (cls === 'pistol' || cls === 'zeus') {
    add(L, 1.2, 1.6, 0, 0, 0.8);
    add(1.4, 1.1, 4, -L * 0.3, 0, -1.6, accent);
    muzzle = [L / 2, 0, 0.9];
  } else {
    const bodyL = L * 0.45;
    add(bodyL, 1.6, 2.6, 0, 0, 0); // receiver
    add(L * 0.3, 0.7, 0.7, bodyL / 2 + L * 0.15, 0, 0.6); // barrel
    add(L * 0.25, 1.4, 2.2, -bodyL / 2 - L * 0.12, 0, -0.2, accent); // stock
    add(1.4, 1.3, 4.2, bodyL * 0.15, 0, -3, dark).rotation.y = 0.25; // magazine
    add(1.2, 1.2, 2.8, -bodyL * 0.25, 0, -2.4, accent); // grip
    if (cls === 'sniper') add(L * 0.25, 1.2, 1.2, 0, 0, 2.2); // scope
    muzzle = [L / 2, 0, 0.6];
  }
  const object = new THREE.Group();
  object.add(g);
  return { object, length: L, size: [L, 2, 4], muzzle, placeholder: true };
}
