// ---------------------------------------------------------------------------
// glb.js — a tiny .glb (binary glTF 2.0) reader shared by browser and server.
//
// The browser uses Three.js's GLTFLoader to DRAW the map, but physics needs
// the exact same triangles on the client and on the Cloudflare server (which
// has no Three.js). This file reads just positions, indices, node transforms
// and names — nothing else — so both sides build identical collision.
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_INFO = {
  5120: { bytes: 1, read: (dv, o) => dv.getInt8(o), norm: 127 },
  5121: { bytes: 1, read: (dv, o) => dv.getUint8(o), norm: 255 },
  5122: { bytes: 2, read: (dv, o) => dv.getInt16(o, true), norm: 32767 },
  5123: { bytes: 2, read: (dv, o) => dv.getUint16(o, true), norm: 65535 },
  5125: { bytes: 4, read: (dv, o) => dv.getUint32(o, true), norm: 1 },
  5126: { bytes: 4, read: (dv, o) => dv.getFloat32(o, true), norm: 1 },
};
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Split a .glb ArrayBuffer into its JSON description and binary payload. */
export function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a .glb file');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const length = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, start, length)));
    } else if (type === CHUNK_BIN) {
      bin = new DataView(arrayBuffer, start, length);
    }
    offset = start + length;
  }
  if (!json) throw new Error('.glb has no JSON chunk');
  return { json, bin };
}

/** Read an accessor into a plain Float64Array (handles interleaving/stride). */
export function readAccessor(gltf, index) {
  const acc = gltf.json.accessors[index];
  const count = acc.count;
  const size = TYPE_SIZE[acc.type];
  const out = new Float64Array(count * size);
  if (acc.bufferView === undefined) return out; // all zeros per spec
  if (acc.sparse) throw new Error('Sparse accessors are not supported in map files');
  const view = gltf.json.bufferViews[acc.bufferView];
  const info = COMPONENT_INFO[acc.componentType];
  const stride = view.byteStride || info.bytes * size;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = gltf.bin;
  const scale = acc.normalized ? 1 / info.norm : 1;
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < size; c++) out[i * size + c] = info.read(dv, o + c * info.bytes) * scale;
  }
  return out;
}

// --- 4x4 column-major matrix helpers (same layout as glTF and Three.js) ---

export function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4FromNode(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Walk the scene graph and return every triangle mesh primitive with its
 * world-space vertex positions (glTF space, before any axis fix).
 *
 * @param ignoreNodeNames nodes whose own transform is replaced by identity
 *   (Sketchfab wraps models in a "Sketchfab_model" node that only rotates the
 *   model for their web viewer — it is not part of the map).
 */
export function extractPrimitives(gltf, ignoreNodeNames = []) {
  const { json } = gltf;
  const ignored = new Set(ignoreNodeNames);
  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes ? json.scenes[sceneIndex].nodes : json.nodes.map((_, i) => i);
  const results = [];
  const ignoredNodeIndices = [];

  const visit = (nodeIndex, parentMatrix) => {
    const node = json.nodes[nodeIndex];
    let local;
    if (ignored.has(node.name)) {
      local = mat4Identity();
      ignoredNodeIndices.push(nodeIndex);
    } else {
      local = mat4FromNode(node);
    }
    const world = mat4Multiply(parentMatrix, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      mesh.primitives.forEach((prim, primIndex) => {
        const mode = prim.mode ?? 4;
        if (mode !== 4) return; // only plain triangle lists are used for physics
        if (prim.extensions && prim.extensions.KHR_draco_mesh_compression) {
          throw new Error('Map uses Draco compression; export the map without Draco.');
        }
        const pos = readAccessor(gltf, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, prim.attributes.NORMAL) : null;
        const idx = prim.indices !== undefined ? readAccessor(gltf, prim.indices) : null;
        const vertCount = pos.length / 3;
        const indices = idx || Float64Array.from({ length: vertCount }, (_, i) => i);
        // Transform positions (and normals, ignoring non-uniform scale) to world.
        const m = world;
        const wpos = new Float64Array(pos.length);
        const wnrm = nrm ? new Float64Array(nrm.length) : null;
        for (let i = 0; i < vertCount; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          wpos[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          wpos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          wpos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wnrm) {
            const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
            wnrm[i * 3] = m[0] * nx + m[4] * ny + m[8] * nz;
            wnrm[i * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
            wnrm[i * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
          }
        }
        const material = prim.material !== undefined ? json.materials[prim.material] : null;
        results.push({
          nodeIndex,
          nodeName: node.name || '',
          meshName: mesh.name || '',
          materialIndex: prim.material ?? -1,
          materialName: material ? material.name || '' : '',
          primitiveIndex: primIndex,
          positions: wpos,
          normals: wnrm,
          indices,
        });
      });
    }
    for (const child of node.children || []) visit(child, world);
  };

  for (const root of roots) visit(root, mat4Identity());
  return { primitives: results, ignoredNodeIndices };
}
