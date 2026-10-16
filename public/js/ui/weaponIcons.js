// ---------------------------------------------------------------------------
// weaponIcons.js — pictures for the buy menu.
//
// Weapons with a real model (models/weapons/*.glb) are photographed side-on
// once, like CS2's buy menu renders. Everything else gets a simple white
// outline drawing for its type, until you add a model for it.
// ---------------------------------------------------------------------------

import { THREE } from '../render/renderer.js';

const W = 256, H = 112;

// Outline drawings (viewBox 0 0 120 48, barrel pointing left like CS2's icons)
const SHAPES = {
  pistol: 'M30 14h52l4 4v6H62l-2 4-6 1-4 13H38l5-17H30z',
  smg: 'M14 18h24l2-4h40l4 4h16v6l-14 2-4 4H70l-4 14h-8l2-14h-8l-6 6h-8l2-8H14z',
  rifle: 'M4 19h30l3-3h44l3 3h34v6l-22 3-6 10h-8l2-8h-12l-8 12h-9l6-12h-8l-6 4h-9l2-6H4z',
  sniper: 'M2 20h34l2-2h20l2-6h18l2 6h38v6l-20 2-4 10h-8l2-8H68l-6 10h-9l4-10H40l-4 2H2z',
  shotgun: 'M4 18h50v3h12l2-3h42v7l-18 3-6 10h-8l2-8H62l-6 2H40v-3H4z',
  heavy: 'M2 17h28l2-3h48l4 3h34v8l-18 4-4 9h-8l2-7H66v8h-8v-8h-6l-6 6h-9l2-6H34v-2H2z',
  grenade: 'M52 14h12l2 4h-2a12 12 0 1 1-12 0h-2zM66 12l10-4 2 3-10 5z',
  vest: 'M42 8h10l8 6 8-6h10l6 8-4 26H40l-4-26z',
  helmet: 'M34 32a26 22 0 0 1 52 0v4H34zM30 36h60v4H30z',
  defuser: 'M36 12h48v28H36zM44 6h32v6H44zM44 20h10v4H44zM66 20h10v4H66z',
  zeus: 'M32 16h46l6 4v6H62l-2 4-8 1-4 11H38l5-16H32zM84 18l10-6M84 22l12 0M84 26l10 6',
  c4: 'M30 14h60v22H30zM38 20h20v10H38zM64 20h18v4H64z',
};
const SHAPE_FOR = { pistol: 'pistol', smg: 'smg', rifle: 'rifle', sniper: 'sniper', shotgun: 'shotgun', heavy: 'heavy', grenade: 'grenade', zeus: 'zeus', c4: 'c4' };
const EQUIP_SHAPE = { vest: 'vest', vesthelm: 'helmet', helmet: 'helmet', defuser: 'defuser' };

export function outlineIcon(kind) {
  const d = SHAPES[kind] || SHAPES.rifle;
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 48"><path d="${d}" fill="rgba(235,240,245,0.85)" stroke="rgba(255,255,255,0.35)" stroke-width="0.8" stroke-linejoin="round"/></svg>`,
  )}`;
}

export class WeaponIcons {
  constructor(models) {
    this.models = models;
    this.cache = new Map(); // id -> url
    this.pending = new Map(); // id -> Promise<url>
    this.r = null;
  }

  /** Picture for an item right now (outline until the real render is ready). */
  now(id, cls) {
    return this.cache.get(id) || outlineIcon(EQUIP_SHAPE[id] || SHAPE_FOR[cls] || 'rifle');
  }

  /** Promise of the best picture for an item. */
  get(id, cls) {
    if (this.cache.has(id)) return Promise.resolve(this.cache.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const fallback = this.now(id, cls);
    let p;
    if (EQUIP_SHAPE[id] || !this.models) p = Promise.resolve(fallback);
    else {
      p = this.models.load(id, cls)
        .then(() => {
          const inst = this.models.instance(id);
          return inst && !inst.placeholder ? this.photograph(inst.object) : fallback;
        })
        .catch(() => fallback);
    }
    p = p.then((url) => { this.cache.set(id, url); this.pending.delete(id); return url; });
    this.pending.set(id, p);
    return p;
  }

  setup() {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setSize(W, H, false);
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.3, 1, 0.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.0);
    rim.position.set(0.5, -0.4, 1);
    scene.add(rim);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    cam.up.set(0, 0, 1);
    this.r = { renderer: r, scene, cam, key, rim };
  }

  photograph(object) {
    if (!this.r) this.setup();
    const { renderer, scene, cam, key, rim } = this.r;
    scene.add(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    // Side-on from the weapon's left (+Y): the barrel (+X) points left.
    let hw = (size.x / 2) * 1.06, hh = (size.z / 2) * 1.06;
    if (hw / hh < W / H) hw = hh * (W / H); else hh = hw / (W / H);
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
    cam.position.set(c.x, c.y + size.y + 500, c.z);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    key.position.set(c.x - 0.3, c.y + 1, c.z + 0.8);
    key.target.position.copy(c);
    rim.target.position.copy(c);
    key.target.updateMatrixWorld();
    rim.target.updateMatrixWorld();
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(object);
    return url;
  }
}
