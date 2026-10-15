// ---------------------------------------------------------------------------
// mapLoader.js — turns a .glb map into collision triangles in Hammer units.
//
// Used by BOTH the browser (for prediction) and the server (authoritative),
// so both get byte-for-byte identical collision.
//
// What it does:
//   1. Reads every triangle from the .glb (see glb.js).
//   2. Applies MAP_SCALE (in config/map.js) so 1 unit = 1 Hammer unit.
//   3. Detects which way is "up" and rotates the map so +Z is up, like Hammer.
//   4. Decides per mesh: draw it? collide with it? (clip/nodraw/tools meshes
//      become invisible collision, tiny decorations are skipped for collision).
// ---------------------------------------------------------------------------

import { parseGLB, extractPrimitives } from './glb.js';

// Rows of a rotation matrix that maps glTF axes to world (Hammer) axes so the
// detected "up" direction becomes +Z. All of these are proper rotations
// (no mirroring). '+y' is the standard glTF convention.
const UP_BASES = {
  '+z': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  '-z': [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
  '+y': [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  '-y': [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  '+x': [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  '-x': [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
};

/**
 * Work out which glTF axis points "up" by measuring how much floor-like
 * surface area faces each direction. Floors outweigh ceilings in a playable
 * map, so the direction with the most facing area is up.
 */
export function detectUpAxis(primitives) {
  const area = { '+x': 0, '-x': 0, '+y': 0, '-y': 0, '+z': 0, '-z': 0 };
  for (const p of primitives) {
    const P = p.positions, N = p.normals, I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) continue;
      nx /= len; ny /= len; nz /= len;
      // Trust the file's vertex normals for which side is the "front".
      if (N) {
        const vx = N[a] + N[b] + N[c], vy = N[a + 1] + N[b + 1] + N[c + 1], vz = N[a + 2] + N[b + 2] + N[c + 2];
        if (vx * nx + vy * ny + vz * nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      const ar = len / 2;
      if (nx > 0.9) area['+x'] += ar; else if (nx < -0.9) area['-x'] += ar;
      if (ny > 0.9) area['+y'] += ar; else if (ny < -0.9) area['-y'] += ar;
      if (nz > 0.9) area['+z'] += ar; else if (nz < -0.9) area['-z'] += ar;
    }
  }
  let best = '+y';
  for (const k of Object.keys(area)) if (area[k] > area[best]) best = k;
  return { up: best, area };
}

/** Decide what to do with a mesh based on its node/mesh/material names. */
export function classifyPrimitive(names, config) {
  const text = names.join(' ');
  if (config.SKIP_PATTERN && config.SKIP_PATTERN.test(text)) return 'skip';
  if (config.COLLISION_ONLY_PATTERN && config.COLLISION_ONLY_PATTERN.test(text)) return 'collisionOnly';
  return 'normal';
}

/**
 * Load map geometry.
 * @param {ArrayBuffer} arrayBuffer the .glb file
 * @param {object} config the MAP object from config/map.js
 */
export function loadMapGeometry(arrayBuffer, config) {
  const gltf = parseGLB(arrayBuffer);
  const { primitives, ignoredNodeIndices } = extractPrimitives(gltf, config.IGNORE_NODE_TRANSFORMS || []);

  let upAxis = config.UP_AXIS || 'auto';
  let detection = null;
  if (upAxis === 'auto') {
    detection = detectUpAxis(primitives);
    upAxis = detection.up;
  }
  const rows = UP_BASES[upAxis].map((r) => r.slice());
  if (config.MIRROR_X) rows[0] = rows[0].map((v) => -v);
  const s = config.MAP_SCALE || 1;

  // Column-major 4x4 for Three.js: world = basis * gltf.
  const basis = [
    rows[0][0] * s, rows[1][0] * s, rows[2][0] * s, 0,
    rows[0][1] * s, rows[1][1] * s, rows[2][1] * s, 0,
    rows[0][2] * s, rows[1][2] * s, rows[2][2] * s, 0,
    0, 0, 0, 1,
  ];

  const tris = [];
  const hidden = []; // {nodeIndex, primitiveIndex} the renderer must not draw
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let skippedTiny = 0, collisionOnly = 0, skipped = 0;
  const tiny = config.TINY_MESH_SIZE || 0;

  for (const p of primitives) {
    const kind = classifyPrimitive([p.nodeName, p.meshName, p.materialName], config);
    if (kind !== 'normal') hidden.push({ nodeIndex: p.nodeIndex, primitiveIndex: p.primitiveIndex, materialIndex: p.materialIndex });
    if (kind === 'skip') { skipped++; continue; }
    if (kind === 'collisionOnly') collisionOnly++;

    // Convert vertices to world (Hammer) space.
    const P = p.positions;
    const W = new Float64Array(P.length);
    const pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      for (let r = 0; r < 3; r++) {
        const v = (rows[r][0] * x + rows[r][1] * y + rows[r][2] * z) * s;
        W[i + r] = v;
        if (v < pmin[r]) pmin[r] = v;
        if (v > pmax[r]) pmax[r] = v;
      }
    }
    for (let r = 0; r < 3; r++) { min[r] = Math.min(min[r], pmin[r]); max[r] = Math.max(max[r], pmax[r]); }

    // Small decorative bits (bottles, wires...) would make you snag: skip them.
    const extent = Math.max(pmax[0] - pmin[0], pmax[1] - pmin[1], pmax[2] - pmin[2]);
    if (kind === 'normal' && extent < tiny) { skippedTiny++; continue; }

    const I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      tris.push(W[a], W[a + 1], W[a + 2], W[b], W[b + 1], W[b + 2], W[c], W[c + 1], W[c + 2]);
    }
  }

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const report = [];
  report.push(`[map] ${config.name}: ${primitives.length} meshes, ${tris.length / 9} collision triangles`);
  if (detection) {
    const a = Object.entries(detection.area).map(([k, v]) => `${k}:${Math.round(v)}`).join(' ');
    report.push(`[map] up axis auto-detected as ${upAxis} (facing area ${a})`);
  } else {
    report.push(`[map] up axis forced to ${upAxis} by config`);
  }
  report.push(`[map] MAP_SCALE = ${s}`);
  report.push(`[map] bounding box size (Hammer units): X ${size[0].toFixed(0)}  Y ${size[1].toFixed(0)}  Z ${size[2].toFixed(0)}`);
  report.push(`[map] bounds min (${min.map((v) => v.toFixed(0)).join(', ')}) max (${max.map((v) => v.toFixed(0)).join(', ')})`);
  const largest = Math.max(size[0], size[1]);
  if (largest < 300) report.push('[map] WARNING: map is tiny — it was probably exported in meters. Try MAP_SCALE = 39.37 in config/map.js');
  else if (largest > 40000) report.push('[map] WARNING: map is huge — check MAP_SCALE in config/map.js');
  else report.push('[map] scale looks right (a typical CS map is a few thousand units across)');
  if (collisionOnly) report.push(`[map] ${collisionOnly} clip/nodraw meshes are invisible collision`);
  if (skipped) report.push(`[map] ${skipped} trigger/skip meshes ignored`);
  if (skippedTiny) report.push(`[map] ${skippedTiny} tiny meshes skipped for collision`);

  return {
    triangles: Float64Array.from(tris),
    bounds: { min, max },
    size,
    upAxis,
    basis,
    hidden,
    ignoredNodeIndices,
    report,
  };
}
