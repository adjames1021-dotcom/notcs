// ---------------------------------------------------------------------------
// collision.js — fast box and ray traces against the map's triangles.
//
// Source engine movement is built on one operation: "sweep the player's box
// from A to B and tell me where it first touches something". This file does
// exactly that against the triangle mesh, using the Separating Axis Theorem
// (13 axes per triangle). It keeps boxes DIST_EPSILON (1/32 unit) away from
// walls just like Source, which is what makes sliding along walls smooth.
//
// A uniform grid (in X/Y) makes sure each trace only tests nearby triangles.
// Shared by browser + server, so both get identical results.
// ---------------------------------------------------------------------------

import { COLLISION } from './constants.js';

const EPS = COLLISION.DIST_EPSILON;
const TOL = COLLISION.DIST_EPSILON; // overlap smaller than this counts as "touching"
const PARALLEL = 1e-6; // movement along an axis smaller than this counts as none

// Prebuilt collision files (see serialize()). Bump SERIAL_FORMAT whenever the
// constructor's maths changes, so old files are rejected instead of used.
const SERIAL_MAGIC = 'NOTCSCOL';
const SERIAL_FORMAT = 1;
const SERIAL_ARRAYS = [
  ['v', Float64Array], ['n', Float64Array], ['d', Float64Array], ['bmin', Float64Array], ['bmax', Float64Array],
  ['ax', Float64Array], ['axMin', Float64Array], ['axMax', Float64Array],
  ['cellStart', Int32Array], ['cellItems', Int32Array], ['axValid', Uint8Array],
];

export function createTrace() {
  return {
    fraction: 1, // 0..1 how far along the sweep we got
    endpos: [0, 0, 0],
    normal: [0, 0, 0], // surface normal of what we hit (points back toward us)
    hit: false,
    startsolid: false, // we started overlapping the thing we hit
    allsolid: false,
    tri: -1, // triangle index (or -1)
    entity: -1, // index into extra boxes (players), or -1 for the world
  };
}

export class CollisionWorld {
  /** @param {Float64Array} triangles 9 numbers per triangle (x,y,z of 3 vertices) */
  constructor(triangles, options = {}) {
    const cell = options.cellSize || COLLISION.GRID_CELL;
    const total = triangles.length / 9;
    const keep = [];
    for (let i = 0; i < total; i++) {
      const o = i * 9;
      const e1x = triangles[o + 3] - triangles[o], e1y = triangles[o + 4] - triangles[o + 1], e1z = triangles[o + 5] - triangles[o + 2];
      const e2x = triangles[o + 6] - triangles[o], e2y = triangles[o + 7] - triangles[o + 1], e2z = triangles[o + 8] - triangles[o + 2];
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      if (Math.hypot(cx, cy, cz) > 1e-6) keep.push(i);
    }
    const n = keep.length;
    this.count = n;
    this.v = new Float64Array(n * 9);
    this.n = new Float64Array(n * 3);
    this.d = new Float64Array(n);
    this.bmin = new Float64Array(n * 3);
    this.bmax = new Float64Array(n * 3);
    // 9 edge-cross axes per triangle (box edges are the world axes)
    this.ax = new Float64Array(n * 27);
    this.axMin = new Float64Array(n * 9);
    this.axMax = new Float64Array(n * 9);
    this.axValid = new Uint8Array(n * 9);

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) {
      const s = keep[k] * 9, o = k * 9;
      for (let j = 0; j < 9; j++) this.v[o + j] = triangles[s + j];
      const V = this.v;
      const e = [
        [V[o + 3] - V[o], V[o + 4] - V[o + 1], V[o + 5] - V[o + 2]],
        [V[o + 6] - V[o + 3], V[o + 7] - V[o + 4], V[o + 8] - V[o + 5]],
        [V[o] - V[o + 6], V[o + 1] - V[o + 7], V[o + 2] - V[o + 8]],
      ];
      let nx = e[0][1] * -e[2][2] - e[0][2] * -e[2][1];
      let ny = e[0][2] * -e[2][0] - e[0][0] * -e[2][2];
      let nz = e[0][0] * -e[2][1] - e[0][1] * -e[2][0];
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      this.n[k * 3] = nx; this.n[k * 3 + 1] = ny; this.n[k * 3 + 2] = nz;
      this.d[k] = nx * V[o] + ny * V[o + 1] + nz * V[o + 2];
      for (let c = 0; c < 3; c++) {
        const lo = Math.min(V[o + c], V[o + 3 + c], V[o + 6 + c]);
        const hi = Math.max(V[o + c], V[o + 3 + c], V[o + 6 + c]);
        this.bmin[k * 3 + c] = lo; this.bmax[k * 3 + c] = hi;
        if (lo < min[c]) min[c] = lo;
        if (hi > max[c]) max[c] = hi;
      }
      // cross(worldAxis, edge) for each of 3 world axes x 3 edges
      let a = 0;
      for (let w = 0; w < 3; w++) {
        for (let j = 0; j < 3; j++, a++) {
          const f = e[j];
          let x, y, z;
          if (w === 0) { x = 0; y = -f[2]; z = f[1]; } // X cross f
          else if (w === 1) { x = f[2]; y = 0; z = -f[0]; } // Y cross f
          else { x = -f[1]; y = f[0]; z = 0; } // Z cross f
          const l = Math.hypot(x, y, z);
          const idx = k * 9 + a;
          if (l < 1e-6) { this.axValid[idx] = 0; continue; }
          x /= l; y /= l; z /= l;
          this.axValid[idx] = 1;
          this.ax[idx * 3] = x; this.ax[idx * 3 + 1] = y; this.ax[idx * 3 + 2] = z;
          const p0 = x * V[o] + y * V[o + 1] + z * V[o + 2];
          const p1 = x * V[o + 3] + y * V[o + 4] + z * V[o + 5];
          const p2 = x * V[o + 6] + y * V[o + 7] + z * V[o + 8];
          this.axMin[idx] = Math.min(p0, p1, p2);
          this.axMax[idx] = Math.max(p0, p1, p2);
        }
      }
    }
    this.bounds = { min, max };

    // Broadphase grid over X/Y.
    this.cell = cell;
    this.gx0 = Math.floor((n ? min[0] : 0) / cell) * cell - cell;
    this.gy0 = Math.floor((n ? min[1] : 0) / cell) * cell - cell;
    this.cols = Math.max(1, Math.ceil(((n ? max[0] : 0) - this.gx0) / cell) + 2);
    this.rows = Math.max(1, Math.ceil(((n ? max[1] : 0) - this.gy0) / cell) + 2);
    const counts = new Int32Array(this.cols * this.rows);
    const forCells = (k, fn) => {
      const c0 = this.cellX(this.bmin[k * 3]), c1 = this.cellX(this.bmax[k * 3]);
      const r0 = this.cellY(this.bmin[k * 3 + 1]), r1 = this.cellY(this.bmax[k * 3 + 1]);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * this.cols + c);
    };
    for (let k = 0; k < n; k++) forCells(k, (ci) => counts[ci]++);
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    for (let i = 0; i < counts.length; i++) this.cellStart[i + 1] = this.cellStart[i] + counts[i];
    this.cellItems = new Int32Array(this.cellStart[counts.length]);
    const fill = this.cellStart.slice(0, counts.length);
    for (let k = 0; k < n; k++) forCells(k, (ci) => { this.cellItems[fill[ci]++] = k; });

    this.stamp = new Uint32Array(n);
    this.stampId = 0;
    this._hitT = 0;
    this._hitN = [0, 0, 0];
    this._startsolid = false;
  }

  /**
   * Pack everything the constructor computed into one binary, so the server
   * can load the map in ~1 ms instead of ~100 ms of CPU (Cloudflare's free
   * plan only allows 10 ms per request). Made by tools/build-map.mjs.
   * Numbers are stored as exact Float64 copies, so a world loaded from this
   * file traces exactly like one built from the .glb (prediction stays exact).
   */
  serialize(meta = {}) {
    const header = {
      format: SERIAL_FORMAT, count: this.count, cell: this.cell, gx0: this.gx0, gy0: this.gy0,
      cols: this.cols, rows: this.rows, bounds: this.bounds, meta, arrays: [],
    };
    let offset = 0;
    for (const [name] of SERIAL_ARRAYS) {
      const arr = this[name];
      header.arrays.push({ name, offset, length: arr.length });
      offset += Math.ceil(arr.byteLength / 8) * 8;
    }
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const headerSize = Math.ceil((16 + headerBytes.length) / 8) * 8;
    const out = new Uint8Array(headerSize + offset);
    out.set(new TextEncoder().encode(SERIAL_MAGIC), 0);
    new DataView(out.buffer).setUint32(8, headerBytes.length, true);
    out.set(headerBytes, 16);
    for (let i = 0; i < SERIAL_ARRAYS.length; i++) {
      const arr = this[SERIAL_ARRAYS[i][0]];
      out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), headerSize + header.arrays[i].offset);
    }
    return out;
  }

  /** Inverse of serialize(). Throws if the file is from another version. */
  static deserialize(buffer) {
    const bytes = new Uint8Array(buffer);
    if (new TextDecoder().decode(bytes.subarray(0, 8)) !== SERIAL_MAGIC) throw new Error('not a collision file');
    const headerLen = new DataView(buffer).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headerLen)));
    if (header.format !== SERIAL_FORMAT) throw new Error(`collision file format ${header.format}, expected ${SERIAL_FORMAT}`);
    const headerSize = Math.ceil((16 + headerLen) / 8) * 8;
    const w = Object.create(CollisionWorld.prototype);
    for (let i = 0; i < SERIAL_ARRAYS.length; i++) {
      const [name, Type] = SERIAL_ARRAYS[i];
      const a = header.arrays[i];
      if (a.name !== name) throw new Error('collision file layout mismatch');
      w[name] = new Type(buffer, headerSize + a.offset, a.length);
    }
    w.count = header.count;
    w.cell = header.cell;
    w.gx0 = header.gx0; w.gy0 = header.gy0;
    w.cols = header.cols; w.rows = header.rows;
    w.bounds = header.bounds;
    w.meta = header.meta;
    w.stamp = new Uint32Array(w.count);
    w.stampId = 0;
    w._hitT = 0;
    w._hitN = [0, 0, 0];
    w._startsolid = false;
    return w;
  }

  cellX(x) { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.gx0) / this.cell))); }
  cellY(y) { return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.gy0) / this.cell))); }

  nextStamp() {
    this.stampId = (this.stampId + 1) >>> 0;
    if (this.stampId === 0) { this.stamp.fill(0); this.stampId = 1; }
    return this.stampId;
  }

  /**
   * Swept-box vs triangle k. Box centre (cx,cy,cz), half extents (ex,ey,ez),
   * movement (dx,dy,dz). Returns true on hit; result in this._hitT/_hitN.
   */
  sweepTriangle(k, cx, cy, cz, ex, ey, ez, dx, dy, dz) {
    let tEnter = -Infinity, tExit = Infinity;
    let hnx = 0, hny = 0, hnz = 0;
    const V = this.v, o = k * 9;

    // One SAT axis. Returns false when this axis proves there is no hit.
    const axis = (axx, axy, axz, tmin, tmax) => {
      const r = ex * Math.abs(axx) + ey * Math.abs(axy) + ez * Math.abs(axz);
      const cs = cx * axx + cy * axy + cz * axz;
      const v = dx * axx + dy * axy + dz * axz;
      const lowGap = tmin - (cs + r);
      const highGap = (cs - r) - tmax;
      let enter, exit, nx, ny, nz;
      if (lowGap > -TOL) {
        if (v < PARALLEL) return false; // separated and not approaching
        enter = (lowGap - EPS) / v;
        exit = (tmax - (cs - r)) / v;
        nx = -axx; ny = -axy; nz = -axz;
      } else if (highGap > -TOL) {
        if (v > -PARALLEL) return false;
        enter = (highGap - EPS) / -v;
        exit = ((cs + r) - tmin) / -v;
        nx = axx; ny = axy; nz = axz;
      } else {
        enter = -Infinity;
        exit = v > PARALLEL ? (tmax - (cs - r)) / v : v < -PARALLEL ? ((cs + r) - tmin) / -v : Infinity;
      }
      if (enter > tEnter) { tEnter = enter; hnx = nx; hny = ny; hnz = nz; }
      if (exit < tExit) tExit = exit;
      return tEnter <= tExit && tEnter <= 1;
    };

    // 1) triangle normal
    const tnx = this.n[k * 3], tny = this.n[k * 3 + 1], tnz = this.n[k * 3 + 2];
    const td = this.d[k];
    if (!axis(tnx, tny, tnz, td, td)) return false;
    // 2) the three world axes (triangle bounds)
    if (!axis(1, 0, 0, this.bmin[k * 3], this.bmax[k * 3])) return false;
    if (!axis(0, 1, 0, this.bmin[k * 3 + 1], this.bmax[k * 3 + 1])) return false;
    if (!axis(0, 0, 1, this.bmin[k * 3 + 2], this.bmax[k * 3 + 2])) return false;
    // 3) the nine edge-cross axes
    for (let a = 0; a < 9; a++) {
      const idx = k * 9 + a;
      if (!this.axValid[idx]) continue;
      if (!axis(this.ax[idx * 3], this.ax[idx * 3 + 1], this.ax[idx * 3 + 2], this.axMin[idx], this.axMax[idx])) return false;
    }

    if (tEnter === -Infinity) {
      // We start overlapping this triangle. Let the box leave (or slide along)
      // so a slightly-stuck player can always escape; block moving deeper.
      const side = (cx * tnx + cy * tny + cz * tnz - td) >= 0 ? 1 : -1;
      const vn = (dx * tnx + dy * tny + dz * tnz) * side;
      if (vn >= -PARALLEL) return false;
      this._hitT = 0;
      this._hitN[0] = tnx * side; this._hitN[1] = tny * side; this._hitN[2] = tnz * side;
      this._startsolid = true;
      return true;
    }
    this._hitT = tEnter < 0 ? 0 : tEnter;
    this._hitN[0] = hnx; this._hitN[1] = hny; this._hitN[2] = hnz;
    this._startsolid = false;
    return true;
  }

  /**
   * Sweep an axis-aligned box from start to end.
   * @param start,end [x,y,z] origin positions (box = origin + mins..maxs)
   * @param boxes optional extra solid boxes (e.g. other players):
   *        [{ min:[x,y,z], max:[x,y,z], id }]
   */
  traceBox(start, end, mins, maxs, out = createTrace(), boxes = null) {
    const ex = (maxs[0] - mins[0]) * 0.5, ey = (maxs[1] - mins[1]) * 0.5, ez = (maxs[2] - mins[2]) * 0.5;
    const cx = start[0] + (mins[0] + maxs[0]) * 0.5;
    const cy = start[1] + (mins[1] + maxs[1]) * 0.5;
    const cz = start[2] + (mins[2] + maxs[2]) * 0.5;
    const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];

    let best = 1, bestDot = Infinity, hit = false, bestTri = -1, bestEnt = -1, solid = false;
    let bnx = 0, bny = 0, bnz = 0;
    const consider = (t, nx, ny, nz, startsolid, tri, ent) => {
      const dot = nx * dx + ny * dy + nz * dz; // most opposing normal wins ties
      if (!hit || t < best - 1e-9 || (t <= best + 1e-9 && dot < bestDot)) {
        best = t; bestDot = dot; bnx = nx; bny = ny; bnz = nz; hit = true; solid = startsolid; bestTri = tri; bestEnt = ent;
      }
    };

    if (this.count) {
      const pad = 1;
      const x0 = Math.min(cx, cx + dx) - ex - pad, x1 = Math.max(cx, cx + dx) + ex + pad;
      const y0 = Math.min(cy, cy + dy) - ey - pad, y1 = Math.max(cy, cy + dy) + ey + pad;
      const z0 = Math.min(cz, cz + dz) - ez - pad, z1 = Math.max(cz, cz + dz) + ez + pad;
      const c0 = this.cellX(x0), c1 = this.cellX(x1), r0 = this.cellY(y0), r1 = this.cellY(y1);
      const stamp = this.nextStamp();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const ci = r * this.cols + c;
          for (let p = this.cellStart[ci], pe = this.cellStart[ci + 1]; p < pe; p++) {
            const k = this.cellItems[p];
            if (this.stamp[k] === stamp) continue;
            this.stamp[k] = stamp;
            if (this.bmax[k * 3] < x0 || this.bmin[k * 3] > x1 || this.bmax[k * 3 + 1] < y0 || this.bmin[k * 3 + 1] > y1 ||
              this.bmax[k * 3 + 2] < z0 || this.bmin[k * 3 + 2] > z1) continue;
            if (this.sweepTriangle(k, cx, cy, cz, ex, ey, ez, dx, dy, dz)) {
              consider(this._hitT, this._hitN[0], this._hitN[1], this._hitN[2], this._startsolid, k, -1);
            }
          }
        }
      }
    }
    if (boxes) {
      for (let b = 0; b < boxes.length; b++) {
        if (this.sweepAABB(boxes[b], cx, cy, cz, ex, ey, ez, dx, dy, dz)) {
          consider(this._hitT, this._hitN[0], this._hitN[1], this._hitN[2], this._startsolid, -1, b);
        }
      }
    }

    out.hit = hit;
    out.fraction = hit ? best : 1;
    out.normal[0] = hit ? bnx : 0; out.normal[1] = hit ? bny : 0; out.normal[2] = hit ? bnz : 0;
    out.startsolid = hit && solid;
    out.allsolid = false;
    out.tri = bestTri;
    out.entity = bestEnt;
    out.endpos[0] = start[0] + dx * out.fraction;
    out.endpos[1] = start[1] + dy * out.fraction;
    out.endpos[2] = start[2] + dz * out.fraction;
    return out;
  }

  /** Swept box vs a solid axis-aligned box (players). */
  sweepAABB(box, cx, cy, cz, ex, ey, ez, dx, dy, dz) {
    let tEnter = -Infinity, tExit = Infinity, hn = [0, 0, 0];
    const c = [cx, cy, cz], e = [ex, ey, ez], d = [dx, dy, dz];
    for (let a = 0; a < 3; a++) {
      const lowGap = box.min[a] - (c[a] + e[a]);
      const highGap = (c[a] - e[a]) - box.max[a];
      let enter, exit, sign = 0;
      if (lowGap > -TOL) {
        if (d[a] < PARALLEL) return false;
        enter = (lowGap - EPS) / d[a]; exit = (box.max[a] - (c[a] - e[a])) / d[a]; sign = -1;
      } else if (highGap > -TOL) {
        if (d[a] > -PARALLEL) return false;
        enter = (highGap - EPS) / -d[a]; exit = ((c[a] + e[a]) - box.min[a]) / -d[a]; sign = 1;
      } else {
        enter = -Infinity;
        exit = d[a] > PARALLEL ? (box.max[a] - (c[a] - e[a])) / d[a] : d[a] < -PARALLEL ? ((c[a] + e[a]) - box.min[a]) / -d[a] : Infinity;
      }
      if (enter > tEnter) { tEnter = enter; hn = [0, 0, 0]; hn[a] = sign; }
      if (exit < tExit) tExit = exit;
      if (tEnter > tExit || tEnter > 1) return false;
    }
    if (tEnter === -Infinity) {
      // Overlapping another player: let them separate, block moving inward.
      const bc = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
      const away = (cx - bc[0]) * dx + (cy - bc[1]) * dy;
      if (away >= 0) return false;
      this._hitT = 0;
      const l = Math.hypot(cx - bc[0], cy - bc[1]) || 1;
      this._hitN[0] = (cx - bc[0]) / l; this._hitN[1] = (cy - bc[1]) / l; this._hitN[2] = 0;
      this._startsolid = true;
      return true;
    }
    this._hitT = tEnter < 0 ? 0 : tEnter;
    this._hitN[0] = hn[0]; this._hitN[1] = hn[1]; this._hitN[2] = hn[2];
    this._startsolid = false;
    return true;
  }

  /** True if a box at `pos` overlaps any triangle (deeper than touching). */
  testBox(pos, mins, maxs, boxes = null) {
    const ex = (maxs[0] - mins[0]) * 0.5, ey = (maxs[1] - mins[1]) * 0.5, ez = (maxs[2] - mins[2]) * 0.5;
    const cx = pos[0] + (mins[0] + maxs[0]) * 0.5;
    const cy = pos[1] + (mins[1] + maxs[1]) * 0.5;
    const cz = pos[2] + (mins[2] + maxs[2]) * 0.5;
    if (boxes) {
      for (const b of boxes) {
        if (b.min[0] - (cx + ex) <= -TOL && (cx - ex) - b.max[0] <= -TOL &&
          b.min[1] - (cy + ey) <= -TOL && (cy - ey) - b.max[1] <= -TOL &&
          b.min[2] - (cz + ez) <= -TOL && (cz - ez) - b.max[2] <= -TOL) return true;
      }
    }
    if (!this.count) return false;
    const x0 = cx - ex, x1 = cx + ex, y0 = cy - ey, y1 = cy + ey, z0 = cz - ez, z1 = cz + ez;
    const c0 = this.cellX(x0), c1 = this.cellX(x1), r0 = this.cellY(y0), r1 = this.cellY(y1);
    const stamp = this.nextStamp();
    const sep = (axx, axy, axz, tmin, tmax) => {
      const r = ex * Math.abs(axx) + ey * Math.abs(axy) + ez * Math.abs(axz);
      const cs = cx * axx + cy * axy + cz * axz;
      return tmin - (cs + r) > -TOL || (cs - r) - tmax > -TOL;
    };
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ci = r * this.cols + c;
        for (let p = this.cellStart[ci], pe = this.cellStart[ci + 1]; p < pe; p++) {
          const k = this.cellItems[p];
          if (this.stamp[k] === stamp) continue;
          this.stamp[k] = stamp;
          if (this.bmax[k * 3] < x0 || this.bmin[k * 3] > x1 || this.bmax[k * 3 + 1] < y0 || this.bmin[k * 3 + 1] > y1 ||
            this.bmax[k * 3 + 2] < z0 || this.bmin[k * 3 + 2] > z1) continue;
          const td = this.d[k];
          if (sep(this.n[k * 3], this.n[k * 3 + 1], this.n[k * 3 + 2], td, td)) continue;
          if (sep(1, 0, 0, this.bmin[k * 3], this.bmax[k * 3])) continue;
          if (sep(0, 1, 0, this.bmin[k * 3 + 1], this.bmax[k * 3 + 1])) continue;
          if (sep(0, 0, 1, this.bmin[k * 3 + 2], this.bmax[k * 3 + 2])) continue;
          let separated = false;
          for (let a = 0; a < 9 && !separated; a++) {
            const idx = k * 9 + a;
            if (this.axValid[idx] && sep(this.ax[idx * 3], this.ax[idx * 3 + 1], this.ax[idx * 3 + 2], this.axMin[idx], this.axMax[idx])) separated = true;
          }
          if (!separated) return true;
        }
      }
    }
    return false;
  }

  /**
   * Ray (line segment) trace against triangles — used for bullets, line of
   * sight and grenades. Hits both sides of triangles.
   * out.normal is the triangle's normal flipped to face the ray start, and
   * out.backface tells you whether the triangle's real front faced away
   * (useful to find where a bullet exits a wall).
   */
  traceRay(start, end, out = createTrace(), ignoreBefore = 0) {
    const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
    out.hit = false; out.fraction = 1; out.tri = -1; out.entity = -1; out.startsolid = false; out.allsolid = false;
    out.normal[0] = out.normal[1] = out.normal[2] = 0;
    out.backface = false;
    if (this.count) {
      const stamp = this.nextStamp();
      let best = 1, bestK = -1;
      const testCell = (ci) => {
        for (let p = this.cellStart[ci], pe = this.cellStart[ci + 1]; p < pe; p++) {
          const k = this.cellItems[p];
          if (this.stamp[k] === stamp) continue;
          this.stamp[k] = stamp;
          const t = this.rayTriangle(k, start, dx, dy, dz);
          if (t !== null && t > ignoreBefore && t < best) { best = t; bestK = k; }
        }
      };
      // Walk the grid cells the ray passes through (2D DDA).
      const cell = this.cell;
      let gx = (start[0] - this.gx0) / cell, gy = (start[1] - this.gy0) / cell;
      const ddx = dx / cell, ddy = dy / cell;
      let cx = Math.floor(gx), cy = Math.floor(gy);
      const stepX = ddx > 0 ? 1 : -1, stepY = ddy > 0 ? 1 : -1;
      const tDeltaX = ddx !== 0 ? Math.abs(1 / ddx) : Infinity;
      const tDeltaY = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
      let tMaxX = ddx > 0 ? (cx + 1 - gx) / ddx : ddx < 0 ? (gx - cx) / -ddx : Infinity;
      let tMaxY = ddy > 0 ? (cy + 1 - gy) / ddy : ddy < 0 ? (gy - cy) / -ddy : Infinity;
      let tCur = 0;
      for (let guard = 0; guard < 4096; guard++) {
        if (cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows) testCell(cy * this.cols + cx);
        const tNext = Math.min(tMaxX, tMaxY);
        if (best <= tNext || tNext > 1) break;
        tCur = tNext;
        if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; } else { cy += stepY; tMaxY += tDeltaY; }
        // left the grid in a direction we can't come back from
        if ((cx < 0 && stepX < 0) || (cx >= this.cols && stepX > 0) || (cy < 0 && stepY < 0) || (cy >= this.rows && stepY > 0)) break;
      }
      void tCur;
      if (bestK >= 0) {
        out.hit = true; out.fraction = best; out.tri = bestK;
        const nx = this.n[bestK * 3], ny = this.n[bestK * 3 + 1], nz = this.n[bestK * 3 + 2];
        const facing = nx * dx + ny * dy + nz * dz;
        out.backface = facing > 0;
        const s = facing > 0 ? -1 : 1;
        out.normal[0] = nx * s; out.normal[1] = ny * s; out.normal[2] = nz * s;
      }
    }
    out.endpos[0] = start[0] + dx * out.fraction;
    out.endpos[1] = start[1] + dy * out.fraction;
    out.endpos[2] = start[2] + dz * out.fraction;
    return out;
  }

  /** Möller–Trumbore, double sided. Returns t in [0,1] or null. */
  rayTriangle(k, s, dx, dy, dz) {
    const V = this.v, o = k * 9;
    const e1x = V[o + 3] - V[o], e1y = V[o + 4] - V[o + 1], e1z = V[o + 5] - V[o + 2];
    const e2x = V[o + 6] - V[o], e2y = V[o + 7] - V[o + 1], e2z = V[o + 8] - V[o + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tx = s[0] - V[o], ty = s[1] - V[o + 1], tz = s[2] - V[o + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 0 || t > 1) return null;
    return t;
  }
}
