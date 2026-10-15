// Test helpers: build little test levels out of boxes and ramps, and load
// the real map from disk.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CollisionWorld } from '../public/shared/collision.js';
import { loadMapGeometry } from '../public/shared/mapLoader.js';
import { MAP } from '../public/config/map.js';
import { createCmd } from '../public/shared/usercmd.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 12 triangles of an axis-aligned box, normals facing outward. */
export function boxTris(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const quads = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // top
    [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], // bottom
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // -y
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], // +y
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], // -x
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], // +x
  ];
  const out = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return out;
}

/** A ramp rising along +X from (x0, z0) to (x1, z1), spanning y0..y1. */
export function rampTris(x0, x1, y0, y1, z0, z1) {
  const a = [x0, y0, z0], b = [x1, y0, z1], c = [x1, y1, z1], d = [x0, y1, z0];
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

export function makeWorld(...parts) {
  return new CollisionWorld(Float64Array.from(parts.flat()));
}

/** Big flat floor at z=0 from -4000..4000. */
export function floor() {
  return boxTris([-4000, -4000, -64], [4000, 4000, 0]);
}

let mapCache = null;
export function loadRealMap() {
  if (mapCache) return mapCache;
  const buf = fs.readFileSync(path.join(here, '..', 'public', 'maps', 'de_dust2.glb'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const geo = loadMapGeometry(ab, MAP);
  mapCache = { geo, world: new CollisionWorld(geo.triangles) };
  return mapCache;
}

let cmdNum = 0;
export function cmd(buttons = 0, yaw = 0, pitch = 0) {
  const c = createCmd();
  c.num = ++cmdNum;
  c.buttons = buttons;
  c.yaw = yaw;
  c.pitch = pitch;
  return c;
}

export const speed2d = (ps) => Math.hypot(ps.vel[0], ps.vel[1]);
