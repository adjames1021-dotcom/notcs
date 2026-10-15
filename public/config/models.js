// ---------------------------------------------------------------------------
// config/models.js — which 3D model each weapon/player uses.
//
// To add a model:
//   1. Put the original .glb in source-models/weapons/<id>.glb
//      (e.g. source-models/weapons/awp.glb)
//   2. Run:  npm run models     (makes a small copy in public/models/weapons/)
//   3. Add/adjust its line below. Missing files just show a placeholder gun,
//      so the game always runs.
//   4. Open http://localhost:8787/model-check.html to check it looks right.
//
// Settings per model (all optional):
//   file     path of the .glb (default /models/weapons/<id>.glb)
//   scale    multiply the file's units to get Hammer units. Models made in
//            meters (most Sketchfab models) need 39.37. Default: auto.
//   forward  which way the barrel points IN THE FILE: '+x' '-x' '+y' '-y' '+z' '-z'
//   up       which way is up IN THE FILE (the side the sights are on)
//   view     first-person placement: { pos: [forward, left, up], rot: [pitch, yaw, roll] }
//            in Hammer units / degrees, relative to your eyes
// ---------------------------------------------------------------------------

// Defaults that fit every CS2 model downloaded so far (meters, barrel +Z, up +Y).
export const MODEL_DEFAULTS = {
  scale: 'auto',
  forward: '+z',
  up: '+y',
};

// First-person placement per weapon class (overridden per weapon with `view`).
export const VIEWMODEL_DEFAULTS = {
  rifle: { pos: [34, -10.5, -10.5], rot: [0, 2.5, 0] },
  sniper: { pos: [38, -11, -10.5], rot: [0, 2, 0] },
  smg: { pos: [26, -9, -8.5], rot: [0, 3, 0] },
  heavy: { pos: [34, -11, -12], rot: [0, 2, 0] },
  shotgun: { pos: [32, -10.5, -10.5], rot: [0, 2.5, 0] },
  pistol: { pos: [21, -6.6, -6.0], rot: [0, 3, 0] },
  knife: { pos: [14, -7, -5], rot: [-25, 20, -70] },
  grenade: { pos: [14, -6, -6], rot: [0, 0, 0] },
  c4: { pos: [16, -4, -10], rot: [-40, 0, 0] },
  zeus: { pos: [21, -6.6, -6.0], rot: [0, 3, 0] },
};

// Every weapon in the game. Ones without a model file yet use a placeholder.
export const WEAPON_MODELS = {
  // pistols
  glock: {},
  usps: {},
  p2000: {},
  p250: {},
  fiveseven: {},
  tec9: {},
  cz75a: {},
  elite: { view: { pos: [20, 0, -6.2], rot: [0, 0, 0] } }, // two pistols: centred
  deagle: {},
  r8: {},
  // SMGs
  mac10: {},
  mp9: {},
  mp7: {},
  mp5sd: {},
  ump45: {},
  p90: {},
  bizon: {},
  // heavy
  nova: {},
  xm1014: {},
  sawedoff: {},
  mag7: {},
  m249: {},
  negev: {},
  // rifles
  famas: {},
  galil: {},
  m4a4: {},
  m4a1s: {},
  ak47: {},
  aug: { view: { pos: [30, -10, -10], rot: [0, 2.5, 0] } },
  sg553: {},
  // snipers
  ssg08: {},
  awp: {},
  scar20: {},
  g3sg1: {},
  // other
  knife_ct: { forward: '-x', up: '+y' },
  knife_t: { forward: '-x', up: '+y' },
  zeus: {},
  he: {},
  flash: {},
  smoke: {},
  molotov: {},
  incendiary: {},
  decoy: {},
  c4: { scale: 7.874 }, // this file is 5x too big (Sketchfab wrapper scale)
};

// Player models (none yet — blocky placeholders are used until you add them).
// Put them in source-models/players/t.glb and ct.glb, run `npm run models`,
// then fill these in. Models should be ~72 units tall after scaling.
export const PLAYER_MODELS = {
  T: null, // e.g. { file: '/models/players/t.glb', forward: '+z', up: '+y' }
  CT: null,
};
