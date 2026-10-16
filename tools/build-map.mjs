// ---------------------------------------------------------------------------
// build-map.mjs — prepares data the game needs from the map .glb:
//
//   public/maps/<map>.collision.bin   ready-made collision for the server
//   public/maps/<map>.radar.png       top-down radar picture (HUD, top left)
//   public/maps/<map>.radar.json      where the radar picture sits in the world
//
// Why prebuilt collision: building it from the .glb costs ~100 ms of CPU.
// Cloudflare's free plan allows 10 ms per request, so doing it inside the
// Durable Object risks the lobby being reset. Loading this file takes ~1 ms.
//
// The radar only shows floor that players can actually reach: it starts at
// the spawns and walks outwards over the floor (steps, slopes, drops, jumps up
// to 64 units), checking a small player-sized box against the walls.
//
// You don't need to run this yourself: wrangler runs it before `npm run dev`
// and `npm run deploy` (see [build] in wrangler.toml), so the files always
// match the map. None of them are committed to git.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAP } from '../public/config/map.js';
import { loadMapGeometry } from '../public/shared/mapLoader.js';
import { CollisionWorld } from '../public/shared/collision.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const glbPath = path.join(root, 'public', MAP.file);
const base = glbPath.replace(/\.glb$/i, '');

const t0 = Date.now();
const file = readFileSync(glbPath);
const geo = loadMapGeometry(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), MAP);
const world = new CollisionWorld(geo.triangles);
writeFileSync(base + '.collision.bin', world.serialize({ map: MAP.name, glbBytes: file.byteLength }));
console.log(`[map] collision: ${world.count} triangles, ${(statSync(base + '.collision.bin').size / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms`);

// ---- radar ----------------------------------------------------------------------
const t1 = Date.now();
const U = 8; // units per pixel
const minX = Math.floor(geo.bounds.min[0] / U) * U - U, maxY = Math.ceil(geo.bounds.max[1] / U) * U + U;
const W = Math.ceil((geo.bounds.max[0] - minX) / U) + 2;
const H = Math.ceil((maxY - geo.bounds.min[1]) / U) + 2;

// 1. every up-facing floor height under each pixel
const levels = Array.from({ length: W * H }, () => []);
const T = geo.triangles;
for (let i = 0; i < T.length; i += 9) {
  const ax = T[i], ay = T[i + 1], az = T[i + 2], bx = T[i + 3], by = T[i + 4], bz = T[i + 5], cx = T[i + 6], cy = T[i + 7], cz = T[i + 8];
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-6 || nz / nl < 0.7) continue; // floors and gentle slopes only
  const px = [(ax - minX) / U, (bx - minX) / U, (cx - minX) / U], py = [(maxY - ay) / U, (maxY - by) / U, (maxY - cy) / U];
  const x0 = Math.max(0, Math.floor(Math.min(...px))), x1 = Math.min(W - 1, Math.ceil(Math.max(...px)));
  const y0 = Math.max(0, Math.floor(Math.min(...py))), y1 = Math.min(H - 1, Math.ceil(Math.max(...py)));
  const v0x = px[1] - px[0], v0y = py[1] - py[0], v1x = px[2] - px[0], v1y = py[2] - py[0];
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-9) continue;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const qx = x + 0.5 - px[0], qy = y + 0.5 - py[0];
      const u = (qx * v1y - v1x * qy) / den, v = (v0x * qy - qx * v0y) / den;
      if (u < -0.02 || v < -0.02 || u + v > 1.02) continue;
      levels[y * W + x].push(az + u * (bz - az) + v * (cz - az));
    }
  }
}
for (const l of levels) {
  l.sort((a, b) => a - b);
  for (let k = l.length - 1; k > 0; k--) if (l[k] - l[k - 1] < 8) l.splice(k - 1, 1); // keep the top of close pairs
}

// 2. walk out from the spawns over reachable floor
const MAXL = 8;
const reached = new Float32Array(W * H).fill(NaN); // highest reached floor per pixel
const seen = new Uint8Array(W * H * MAXL);
const probeMin = [-4, -4, 0], probeMax = [4, 4, 50];
const free = (x, y, h) => !world.testBox([minX + (x + 0.5) * U, maxY - (y + 0.5) * U, h + 2], probeMin, probeMax);
const queue = [];
for (const team of ['T', 'CT']) {
  for (const s of MAP.spawns[team]) {
    const x = Math.floor((s[0] - minX) / U), y = Math.floor((maxY - s[1]) / U);
    const l = levels[y * W + x];
    let best = -1;
    for (let k = 0; k < l.length && k < MAXL; k++) if (best < 0 || Math.abs(l[k] - s[2]) < Math.abs(l[best] - s[2])) best = k;
    if (best >= 0 && !seen[(y * W + x) * MAXL + best]) { seen[(y * W + x) * MAXL + best] = 1; queue.push(x, y, best); }
  }
}
for (let qi = 0; qi < queue.length; qi += 3) {
  const x = queue[qi], y = queue[qi + 1], k = queue[qi + 2];
  const h = levels[y * W + x][k];
  const r = reached[y * W + x];
  if (!(r >= h)) reached[y * W + x] = h;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const l = levels[ny * W + nx];
    for (let k2 = 0; k2 < l.length && k2 < MAXL; k2++) {
      const dz = l[k2] - h;
      if (dz > 64 || dz < -300) continue; // jump/crouch-jump up, or drop down
      const key = (ny * W + nx) * MAXL + k2;
      if (seen[key]) continue;
      seen[key] = 1;
      if (!free(nx, ny, l[k2])) continue;
      queue.push(nx, ny, k2);
    }
  }
}

// 3. paint: lighter = higher, dark outline around the edges
let zLo = Infinity, zHi = -Infinity;
for (const z of reached) if (z === z) { zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); }
const rgba = Buffer.alloc(W * H * 4);
const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && reached[y * W + x] === reached[y * W + x];
let painted = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (!has(x, y)) continue;
    painted++;
    const z = reached[y * W + x];
    const edge = !has(x + 1, y) || !has(x - 1, y) || !has(x, y + 1) || !has(x, y - 1) ||
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => Math.abs(reached[(y + dy) * W + x + dx] - z) > 40);
    if (edge) { rgba[o] = 28; rgba[o + 1] = 30; rgba[o + 2] = 34; rgba[o + 3] = 255; continue; }
    const t = (z - zLo) / Math.max(1, zHi - zLo);
    const L = 112 + t * 108;
    rgba[o] = L; rgba[o + 1] = L * 0.97; rgba[o + 2] = L * 0.9; rgba[o + 3] = 235;
  }
}
writeFileSync(base + '.radar.png', png(W, H, rgba));
writeFileSync(base + '.radar.json', JSON.stringify({ minX, maxY, unitsPerPixel: U, width: W, height: H }));
console.log(`[map] radar: ${W}x${H} px, ${painted} reachable pixels, ${Date.now() - t1} ms`);

// ---- a tiny PNG writer (RGBA, no filtering) ---------------------------------------
function png(w, h, data) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
