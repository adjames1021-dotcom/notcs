// ---------------------------------------------------------------------------
// tools/optimize-models.mjs — run with:  npm run models
//
// Takes the big original models you download (e.g. from Sketchfab) and makes
// small, fast-loading copies for the game:
//
//   source-models/weapons/ak47.glb  (6 MB)  ->  public/models/weapons/ak47.glb (~0.7 MB)
//   source-models/players/ct.glb             ->  public/models/players/ct.glb
//
// Textures are resized to 1024px and converted to WebP; geometry is
// compressed with meshopt. Quality stays the same at game distances.
// Only files that are new or changed are processed.
//
// Name the source file after the weapon id used in public/config/models.js
// (ak47, m4a4, awp, usps, deagle, ...). See that file for the full list.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
const FOLDERS = ['weapons', 'players'];
const force = process.argv.includes('--force');

if (!fs.existsSync(cli)) {
  console.error('gltf-transform is not installed. Run "npm install" first.');
  process.exit(1);
}

let done = 0, skipped = 0, failed = 0;
for (const folder of FOLDERS) {
  const srcDir = path.join(root, 'source-models', folder);
  const outDir = path.join(root, 'public', 'models', folder);
  if (!fs.existsSync(srcDir)) continue;
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    if (!/\.(glb|gltf)$/i.test(file)) continue;
    const src = path.join(srcDir, file);
    const out = path.join(outDir, file.replace(/\.gltf$/i, '.glb').toLowerCase().replace(/\s+/g, '_'));
    if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) { skipped++; continue; }
    process.stdout.write(`optimizing ${folder}/${file} ... `);
    const res = spawnSync(process.execPath, [
      cli, 'optimize', src, out,
      '--compress', 'meshopt',
      '--texture-compress', 'webp',
      '--texture-size', '1024',
      '--simplify', 'false',
    ], { encoding: 'utf8' });
    if (res.status !== 0) {
      failed++;
      console.log('FAILED');
      console.log(res.stderr || res.stdout);
      continue;
    }
    const before = fs.statSync(src).size, after = fs.statSync(out).size;
    console.log(`${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(2)} MB`);
    done++;
  }
}
// Write a list of available models so the game doesn't ask for missing files.
const manifest = {};
for (const folder of FOLDERS) {
  const dir = path.join(root, 'public', 'models', folder);
  manifest[folder] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, '')).sort() : [];
}
fs.writeFileSync(path.join(root, 'public', 'models', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${done} optimized, ${skipped} already up to date, ${failed} failed.`);
console.log(`models available: ${manifest.weapons.length} weapons, ${manifest.players.length} players (public/models/manifest.json)`);
if (failed) process.exit(1);
