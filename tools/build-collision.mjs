// ---------------------------------------------------------------------------
// build-collision.mjs — turns the map .glb into a ready-made collision file
// (public/maps/<map>.collision.bin) for the online server.
//
// Why: building collision from the .glb costs ~100 ms of CPU. Cloudflare's
// free plan allows 10 ms per request, so doing it inside the Durable Object
// risks the lobby being reset. Loading this file takes ~1 ms instead.
//
// You don't need to run this yourself: wrangler runs it automatically before
// `npm run dev` and `npm run deploy` (see [build] in wrangler.toml), so the
// file always matches the map. The browser still builds collision from the
// .glb with the same code, so both sides collide identically.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAP } from '../public/config/map.js';
import { loadMapGeometry } from '../public/shared/mapLoader.js';
import { CollisionWorld } from '../public/shared/collision.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const glbPath = path.join(root, 'public', MAP.file);
const outPath = glbPath.replace(/\.glb$/i, '.collision.bin');

const t0 = Date.now();
const file = readFileSync(glbPath);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const geo = loadMapGeometry(buffer, MAP);
const world = new CollisionWorld(geo.triangles);
const bytes = world.serialize({ map: MAP.name, glbBytes: file.byteLength });
writeFileSync(outPath, bytes);
console.log(`[collision] ${path.relative(root, outPath)}: ${world.count} triangles, ` +
  `${(statSync(outPath).size / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms`);
