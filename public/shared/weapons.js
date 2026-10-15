// ---------------------------------------------------------------------------
// weapons.js — the stats of every weapon (shared by browser + server).
//
// Values follow CS2 as closely as I know them. Prices, damage, armor
// penetration, fire rate, magazine/reserve, move speed and kill rewards are
// CS2 values. Reload times are close. The accuracy numbers (inaccuracy/spread
// in milliradians) and recoil patterns are hand-tuned estimates to FEEL like
// CS2 — they're marked TODO so you can tune them.
//
// Units: damage in HP, fire rate in rounds/minute, speed in units/s,
// range in Hammer units, time in seconds, angles in milliradians (mrad,
// 1 mrad ~ 0.057 degrees) for accuracy and degrees for recoil.
// ---------------------------------------------------------------------------

// Hit group damage multipliers (CS2)
export const HITGROUP = { GENERIC: 0, HEAD: 1, CHEST: 2, STOMACH: 3, LEFTARM: 4, RIGHTARM: 5, LEFTLEG: 6, RIGHTLEG: 7, NECK: 8 };
export const HITGROUP_MULT = { 0: 1, 1: 4, 2: 1, 3: 1.25, 4: 1, 5: 1, 6: 0.75, 7: 0.75, 8: 1 };
export const HITGROUP_NAME = { 0: 'body', 1: 'head', 2: 'chest', 3: 'stomach', 4: 'left arm', 5: 'right arm', 6: 'left leg', 7: 'right leg', 8: 'neck' };

// Recoil: bullets go to (view + aimPunch * RECOIL_SCALE); the camera shows
// aimPunch * RECOIL_SCALE * VIEW_TRACKING (CS: weapon_recoil_scale 2, view_recoil_tracking 0.45).
export const RECOIL_SCALE = 2.0;
export const VIEW_TRACKING = 0.45;
export const PUNCH_DECAY_EXP = 8; // per second, when not firing (CS: weapon_recoil_decay2_exp)
export const PUNCH_DECAY_LIN = 18; // degrees per second (CS: weapon_recoil_decay2_lin)

// Recoil pattern shapes. Each entry: [shots, verticalPerShot, horizontalPerShot]
// (degrees of aim punch; +horizontal = to the RIGHT). The pattern is fixed,
// so it's learnable — pull your mouse down/sideways to control it.
const SHAPES = {
  ak: [[1, 0.62, 0.05], [1, 0.66, 0.08], [1, 0.70, 0.10], [1, 0.68, 0.06], [1, 0.64, 0.02], [1, 0.58, -0.04], [1, 0.50, -0.10], [1, 0.40, -0.16], [1, 0.30, -0.22],
    [5, 0.10, -0.38], [6, 0.05, 0.42], [5, 0.06, -0.30], [4, 0.04, 0.32], [6, 0.03, -0.18]],
  m4: [[1, 0.52, 0.02], [1, 0.56, 0.06], [1, 0.58, 0.04], [1, 0.55, -0.02], [1, 0.50, -0.06], [1, 0.44, -0.08], [1, 0.36, -0.06], [1, 0.28, 0.06], [1, 0.20, 0.14],
    [5, 0.08, 0.30], [6, 0.05, -0.34], [6, 0.04, 0.24], [6, 0.03, -0.16]],
  m4s: [[1, 0.42, 0.0], [1, 0.46, 0.04], [1, 0.48, 0.05], [1, 0.45, 0.0], [1, 0.40, -0.06], [1, 0.34, -0.08], [1, 0.27, -0.04], [1, 0.2, 0.06], [1, 0.14, 0.1],
    [5, 0.06, 0.22], [6, 0.04, -0.26]],
  galil: [[1, 0.58, -0.04], [1, 0.62, -0.06], [1, 0.62, -0.02], [1, 0.58, 0.04], [1, 0.52, 0.08], [1, 0.44, 0.1], [1, 0.36, 0.06], [1, 0.26, -0.06],
    [6, 0.10, -0.34], [6, 0.06, 0.36], [6, 0.05, -0.28], [10, 0.03, 0.2]],
  famas: [[1, 0.50, 0.06], [1, 0.54, 0.08], [1, 0.54, 0.04], [1, 0.50, -0.04], [1, 0.44, -0.10], [1, 0.36, -0.12], [1, 0.28, -0.04],
    [6, 0.10, 0.30], [6, 0.06, -0.30], [8, 0.04, 0.22]],
  bullpup: [[1, 0.46, 0.04], [1, 0.50, 0.06], [1, 0.50, 0.06], [1, 0.46, 0.02], [1, 0.40, -0.04], [1, 0.32, -0.08], [1, 0.24, -0.08],
    [6, 0.08, 0.28], [6, 0.05, -0.30], [12, 0.04, 0.2]],
  smg: [[1, 0.36, 0.06], [1, 0.40, 0.08], [1, 0.40, 0.04], [1, 0.36, -0.04], [1, 0.30, -0.08], [1, 0.24, -0.08], [1, 0.18, 0.02],
    [6, 0.08, 0.20], [6, 0.06, -0.24], [6, 0.05, 0.22], [40, 0.03, -0.12]],
  smgSnappy: [[1, 0.44, -0.06], [1, 0.48, -0.08], [1, 0.46, 0.0], [1, 0.40, 0.08], [1, 0.32, 0.12], [1, 0.24, 0.08],
    [6, 0.10, -0.26], [6, 0.07, 0.28], [6, 0.05, -0.22], [40, 0.03, 0.14]],
  lmg: [[1, 0.40, 0.04], [1, 0.42, 0.06], [1, 0.40, 0.04], [1, 0.36, 0.0], [1, 0.30, -0.06], [1, 0.22, -0.08],
    [8, 0.08, 0.22], [8, 0.06, -0.24], [8, 0.04, 0.2], [180, 0.02, -0.1]],
  pistol: [[1, 1.0, 0.0], [1, 1.0, 0.15], [1, 1.0, -0.15], [20, 1.0, 0.1]],
};

function pattern(shape, vScale = 1, hScale = 1, length = 30) {
  const out = [];
  for (const [n, v, h] of SHAPES[shape]) {
    for (let i = 0; i < n && out.length < length; i++) {
      // alternate small horizontal jitter on long segments so it isn't a straight line
      const wob = n > 3 ? (i % 2 ? 0.04 : -0.04) : 0;
      out.push([v * vScale, (h + wob) * hScale]);
    }
  }
  while (out.length < length) out.push(out[out.length - 1]);
  return out;
}

// Defaults per class (TODO: per-weapon tuning)
const CLASS_DEFAULTS = {
  pistol: { killReward: 300, slot: 'secondary', speed: 240, range: 4096, penetration: 1, deploy: 1.0, tag: 0.6, auto: false,
    acc: { spread: 2.0, stand: 6.0, crouch: 4.5, move: 15, air: 140, fire: 40, recovery: 0.35, recoveryCrouch: 0.3 } },
  smg: { killReward: 600, slot: 'primary', speed: 240, range: 4096, penetration: 1, deploy: 1.0, tag: 0.6, auto: true,
    acc: { spread: 2.5, stand: 9.0, crouch: 6.5, move: 45, air: 200, fire: 6.5, recovery: 0.3, recoveryCrouch: 0.25 } },
  shotgun: { killReward: 900, slot: 'primary', speed: 220, range: 3000, penetration: 1, deploy: 1.0, tag: 0.5, auto: false, pellets: 9,
    acc: { spread: 40, stand: 8, crouch: 6, move: 30, air: 160, fire: 20, recovery: 0.4, recoveryCrouch: 0.35 } },
  heavy: { killReward: 300, slot: 'primary', speed: 195, range: 8192, penetration: 2, deploy: 1.25, tag: 0.5, auto: true,
    acc: { spread: 2.0, stand: 9.0, crouch: 6.5, move: 140, air: 300, fire: 4.0, recovery: 0.5, recoveryCrouch: 0.4 } },
  rifle: { killReward: 300, slot: 'primary', speed: 220, range: 8192, penetration: 2, deploy: 1.0, tag: 0.45, auto: true,
    acc: { spread: 0.6, stand: 4.8, crouch: 3.7, move: 140, air: 280, fire: 7.8, recovery: 0.37, recoveryCrouch: 0.28 } },
  sniper: { killReward: 300, slot: 'primary', speed: 230, range: 8192, penetration: 2.5, deploy: 1.25, tag: 0.4, auto: false,
    acc: { spread: 0.3, stand: 60, crouch: 50, move: 160, air: 400, fire: 60, recovery: 0.3, recoveryCrouch: 0.25, scoped: 1.2, scopedCrouch: 0.9 } },
};

// The table. Values: [id, name, cls, team, price, damage, armorPen%, rpm, clip, reserve, reload, speed, rangeMod, extra]
const RAW = [
  // ---------------- pistols ----------------
  ['glock', 'Glock-18', 'pistol', 'T', 200, 30, 47, 400, 20, 120, 2.27, 240, 0.85,
    { burst: { count: 3, interval: 0.05, cycle: 0.5 }, acc: { stand: 5.6, crouch: 4.2, move: 13, fire: 56 }, recoil: pattern('pistol', 1.0, 1) }],
  ['usps', 'USP-S', 'pistol', 'CT', 200, 35, 50.5, 352.94, 12, 24, 2.2, 240, 0.91,
    { silencer: true, acc: { spread: 1.5, stand: 3.5, crouch: 2.6, move: 12, fire: 52 }, recoil: pattern('pistol', 1.4, 1) }],
  ['p2000', 'P2000', 'pistol', 'CT', 200, 35, 50.5, 352.94, 13, 52, 2.2, 240, 0.91,
    { acc: { spread: 1.8, stand: 4.2, crouch: 3.2, move: 13, fire: 50 }, recoil: pattern('pistol', 1.4, 1) }],
  ['p250', 'P250', 'pistol', null, 300, 38, 64, 400, 13, 26, 2.2, 240, 0.85,
    { acc: { stand: 6.8, crouch: 5.0, move: 14, fire: 60 }, recoil: pattern('pistol', 1.6, 1) }],
  ['fiveseven', 'Five-SeveN', 'pistol', 'CT', 500, 32, 91.15, 400, 20, 100, 2.2, 240, 0.81,
    { acc: { stand: 6.2, crouch: 4.6, move: 10, fire: 48 }, recoil: pattern('pistol', 1.5, 1) }],
  ['tec9', 'Tec-9', 'pistol', 'T', 500, 33, 90.6, 500, 18, 90, 2.5, 240, 0.831,
    { acc: { stand: 7.0, crouch: 5.4, move: 7, fire: 40 }, recoil: pattern('pistol', 1.5, 1) }], // good while moving
  ['cz75a', 'CZ75-Auto', 'pistol', null, 500, 31, 77.65, 600, 12, 12, 2.7, 240, 0.85,
    { auto: true, killReward: 100, acc: { stand: 7.0, crouch: 5.3, move: 13, fire: 36 }, recoil: pattern('smgSnappy', 1.6, 1.2, 12) }],
  ['elite', 'Dual Berettas', 'pistol', null, 300, 38, 57.5, 500, 30, 120, 3.77, 240, 0.79,
    { acc: { stand: 6.8, crouch: 5.2, move: 12, fire: 38 }, recoil: pattern('pistol', 1.4, 1.3) }],
  ['deagle', 'Desert Eagle', 'pistol', null, 700, 53, 93.2, 267, 7, 35, 2.2, 230, 0.81,
    { penetration: 2, acc: { spread: 2.0, stand: 7.6, crouch: 5.2, move: 30, air: 220, fire: 105, recovery: 0.6 }, recoil: pattern('pistol', 3.6, 1) }],
  ['r8', 'R8 Revolver', 'pistol', null, 600, 86, 93.2, 120, 8, 8, 2.3, 220, 0.94,
    { penetration: 2, revolver: { cock: 0.4, fanCycle: 0.4 }, acc: { spread: 1.5, stand: 2.6, crouch: 2.0, move: 20, air: 200, fire: 90, recovery: 0.5, fan: 80 }, recoil: pattern('pistol', 3.2, 1) }],

  // ---------------- SMGs ----------------
  ['mac10', 'MAC-10', 'smg', 'T', 1050, 29, 57.5, 800, 30, 100, 2.6, 240, 0.80,
    { acc: { stand: 10.5, crouch: 7.6, move: 35, fire: 6.7 }, recoil: pattern('smgSnappy', 1.0, 1.2) }],
  ['mp9', 'MP9', 'smg', 'CT', 1250, 26, 60, 857, 30, 120, 2.1, 240, 0.87,
    { acc: { stand: 9.5, crouch: 7.0, move: 32, fire: 6.0 }, recoil: pattern('smg', 1.0, 1.1) }],
  ['mp7', 'MP7', 'smg', null, 1500, 29, 62.5, 750, 30, 120, 3.1, 220, 0.85,
    { acc: { stand: 8.0, crouch: 5.8, move: 45, fire: 5.5 }, recoil: pattern('smg', 1.0, 0.9) }],
  ['mp5sd', 'MP5-SD', 'smg', null, 1500, 27, 62.5, 750, 30, 120, 2.95, 235, 0.85,
    { acc: { stand: 7.6, crouch: 5.5, move: 40, fire: 5.2 }, recoil: pattern('smg', 0.9, 0.8) }],
  ['ump45', 'UMP-45', 'smg', null, 1200, 35, 65, 667, 25, 100, 3.5, 230, 0.75,
    { acc: { stand: 9.0, crouch: 6.6, move: 50, fire: 7.5 }, recoil: pattern('smgSnappy', 1.1, 0.9) }],
  ['p90', 'P90', 'smg', null, 2350, 26, 69, 857, 50, 100, 3.3, 230, 0.86,
    { killReward: 300, acc: { stand: 8.5, crouch: 6.4, move: 42, fire: 5.0 }, recoil: pattern('smg', 0.85, 1.0, 50) }],
  ['bizon', 'PP-Bizon', 'smg', null, 1400, 27, 57.5, 750, 64, 120, 2.4, 240, 0.80,
    { acc: { stand: 10.0, crouch: 7.4, move: 40, fire: 5.0 }, recoil: pattern('smg', 0.85, 1.1, 64) }],

  // ---------------- heavy ----------------
  ['nova', 'Nova', 'shotgun', null, 1050, 26, 50, 68.2, 8, 32, 0.5, 220, 0.70,
    { pellets: 9, shellReload: { start: 0.5, shell: 0.5, end: 0.4 }, acc: { spread: 40, stand: 8, crouch: 6.4 }, recoil: pattern('pistol', 3.0, 0.6, 8) }],
  ['xm1014', 'XM1014', 'shotgun', null, 2000, 20, 80, 171, 7, 32, 0.4, 215, 0.70,
    { pellets: 6, auto: true, shellReload: { start: 0.45, shell: 0.38, end: 0.4 }, acc: { spread: 38, stand: 8.6, crouch: 6.8, fire: 30 }, recoil: pattern('pistol', 2.4, 0.8, 7) }],
  ['sawedoff', 'Sawed-Off', 'shotgun', 'T', 1100, 32, 75, 71, 7, 32, 0.5, 210, 0.45,
    { pellets: 8, range: 1400, shellReload: { start: 0.5, shell: 0.5, end: 0.4 }, acc: { spread: 60, stand: 9, crouch: 7.2 }, recoil: pattern('pistol', 3.4, 0.6, 7) }],
  ['mag7', 'MAG-7', 'shotgun', 'CT', 1300, 30, 75, 71, 5, 32, 2.5, 225, 0.45,
    { pellets: 8, range: 1400, acc: { spread: 42, stand: 8, crouch: 6.4 }, recoil: pattern('pistol', 3.4, 0.6, 5) }],
  ['m249', 'M249', 'heavy', null, 5200, 32, 80, 750, 100, 200, 5.7, 195, 0.97,
    { acc: { stand: 9.4, crouch: 6.8, move: 160, fire: 3.8 }, recoil: pattern('lmg', 1.0, 1.1, 100) }],
  ['negev', 'Negev', 'heavy', null, 1700, 35, 71, 800, 150, 300, 5.7, 150, 0.97,
    { negev: true, acc: { stand: 10, crouch: 7.5, move: 170, fire: 6.0 }, recoil: pattern('lmg', 1.2, 1.2, 150) }], // gets MORE accurate as you keep firing

  // ---------------- rifles ----------------
  ['famas', 'FAMAS', 'rifle', 'CT', 2050, 30, 70, 666, 25, 90, 3.3, 220, 0.96,
    { burst: { count: 3, interval: 0.075, cycle: 0.55 }, acc: { stand: 4.9, crouch: 3.9, move: 120, fire: 9.0 }, recoil: pattern('famas', 1, 1, 25) }],
  ['galil', 'Galil AR', 'rifle', 'T', 1800, 30, 77.5, 666, 35, 90, 3.0, 215, 0.98,
    { acc: { stand: 5.2, crouch: 4.1, move: 140, fire: 7.6 }, recoil: pattern('galil', 1, 1, 35) }],
  ['m4a4', 'M4A4', 'rifle', 'CT', 3100, 33, 70, 666, 30, 90, 3.1, 225, 0.97,
    { acc: { stand: 3.7, crouch: 2.7, move: 125, fire: 7.0, recovery: 0.33 }, recoil: pattern('m4', 1, 1) }],
  ['m4a1s', 'M4A1-S', 'rifle', 'CT', 2900, 38, 70, 600, 20, 80, 3.1, 225, 0.99,
    { silencer: true, acc: { spread: 0.5, stand: 3.3, crouch: 2.4, move: 115, fire: 6.5, recovery: 0.35 }, recoil: pattern('m4s', 1, 1, 20) }],
  ['ak47', 'AK-47', 'rifle', 'T', 2700, 36, 77.5, 600, 30, 90, 2.5, 215, 0.98,
    { acc: { stand: 4.81, crouch: 3.68, move: 140, fire: 7.8, recovery: 0.368, recoveryCrouch: 0.276 }, recoil: pattern('ak', 1, 1) }],
  ['aug', 'AUG', 'rifle', 'CT', 3300, 28, 90, 666, 30, 90, 3.8, 220, 0.98,
    { scope: { fov: [45], speed: 150, cycle: 0.12 }, acc: { stand: 3.6, crouch: 2.6, move: 120, fire: 6.8, scoped: 1.6, scopedCrouch: 1.2 }, recoil: pattern('bullpup', 1, 1) }],
  ['sg553', 'SG 553', 'rifle', 'T', 3000, 30, 100, 666, 30, 90, 2.8, 210, 0.98,
    { scope: { fov: [45], speed: 150, cycle: 0.12 }, acc: { stand: 4.0, crouch: 3.0, move: 125, fire: 7.2, scoped: 1.7, scopedCrouch: 1.3 }, recoil: pattern('bullpup', 1.1, 1.1) }],

  // ---------------- snipers ----------------
  ['ssg08', 'SSG 08', 'sniper', null, 1700, 88, 85, 48, 10, 90, 3.7, 230, 0.98,
    { scope: { fov: [40, 15], speed: 230 }, airApex: 0.04, acc: { spread: 0.3, stand: 30, crouch: 25, move: 100, air: 90, fire: 50, scoped: 1.4, scopedCrouch: 1.1 }, recoil: pattern('pistol', 2.2, 0.3, 10) }],
  ['awp', 'AWP', 'sniper', null, 4750, 115, 97.5, 41, 5, 30, 3.7, 200, 0.99,
    { killReward: 100, penetration: 2.5, scope: { fov: [40, 10], speed: 100 }, acc: { spread: 0.2, stand: 80, crouch: 70, move: 175, air: 450, fire: 110, scoped: 1.0, scopedCrouch: 0.75 }, recoil: pattern('pistol', 3.0, 0.3, 5) }],
  ['scar20', 'SCAR-20', 'sniper', 'CT', 5000, 80, 82.5, 240, 20, 90, 3.1, 215, 0.98,
    { auto: true, scope: { fov: [40, 15], speed: 120 }, acc: { spread: 0.3, stand: 25, crouch: 20, move: 120, air: 250, fire: 22, scoped: 1.5, scopedCrouch: 1.1 }, recoil: pattern('smg', 1.6, 0.5, 20) }],
  ['g3sg1', 'G3SG1', 'sniper', 'T', 5000, 80, 82.5, 240, 20, 90, 4.7, 215, 0.98,
    { auto: true, scope: { fov: [40, 15], speed: 120 }, acc: { spread: 0.3, stand: 25, crouch: 20, move: 120, air: 250, fire: 22, scoped: 1.5, scopedCrouch: 1.1 }, recoil: pattern('smg', 1.6, 0.5, 20) }],
];

export const WEAPONS = {};
export const WEAPON_LIST = []; // index -> id (index 0 = nothing)
WEAPON_LIST.push(null);

function define(def) {
  def.index = WEAPON_LIST.length;
  WEAPON_LIST.push(def.id);
  WEAPONS[def.id] = def;
}

for (const [id, name, cls, team, price, damage, armorPen, rpm, clip, reserve, reload, speed, rangeMod, extra = {}] of RAW) {
  const base = CLASS_DEFAULTS[cls];
  define({
    ...base,
    id, name, cls, team, price, damage, armorPen, rpm, clip, reserve, reload, speed, rangeMod,
    ...extra,
    cycle: 60 / rpm,
    acc: { ...base.acc, ...(extra.acc || {}) },
    recoil: extra.recoil || pattern('pistol', 1, 1),
    pellets: extra.pellets || base.pellets || 1,
    gun: true,
  });
}

// Knives: left click slash, right click stab (CS2 values).
for (const [id, team] of [['knife_t', 'T'], ['knife_ct', 'CT']]) {
  define({
    id, name: 'Knife', cls: 'knife', slot: 'knife', team, price: 0, killReward: 1500, speed: 250, deploy: 1.0, gun: false,
    knife: {
      slash: { damage: 40, followUp: 25, backstab: 90, range: 48, cycle: 0.4, firstCycle: 0.5, comboWindow: 0.5 },
      stab: { damage: 65, backstab: 180, range: 32, cycle: 1.0 },
    },
    armorPen: 85, tag: 0.5,
  });
}

// Zeus x27: one-shot taser with short range; recharges in CS2.
define({
  id: 'zeus', name: 'Zeus x27', cls: 'zeus', slot: 'zeus', team: null, price: 200, killReward: 0, speed: 220, deploy: 1.0,
  damage: 500, armorPen: 100, rpm: 60, cycle: 0.35, clip: 1, reserve: 0, reload: 0, rangeMod: 0.1, range: 183,
  recharge: 30, penetration: 0, pellets: 1, auto: false, gun: true, tag: 0.2,
  acc: { spread: 2, stand: 4, crouch: 4, move: 10, air: 40, fire: 0, recovery: 0.3, recoveryCrouch: 0.3 },
  recoil: pattern('pistol', 0.5, 0, 1),
});

// Grenades (stage 4 uses these). Prices/limits are CS2.
const NADES = [
  ['he', 'HE Grenade', null, 300, { fuse: 1.5, damage: 98, radius: 350 }],
  ['flash', 'Flashbang', null, 200, { fuse: 1.5, max: 2 }],
  ['smoke', 'Smoke Grenade', null, 300, { fuse: 'rest', duration: 18 }],
  ['molotov', 'Molotov', 'T', 400, { fuse: 2.0, duration: 7 }],
  ['incendiary', 'Incendiary Grenade', 'CT', 500, { fuse: 2.0, duration: 7 }],
  ['decoy', 'Decoy Grenade', null, 50, { fuse: 'rest', duration: 15 }],
];
for (const [id, name, team, price, nade] of NADES) {
  define({ id, name, cls: 'grenade', slot: 'grenade', team, price, killReward: 300, speed: 245, deploy: 0.6, gun: false, nade, armorPen: 57.5 });
}

define({ id: 'c4', name: 'C4 Explosive', cls: 'c4', slot: 'c4', team: 'T', price: 0, killReward: 300, speed: 250, deploy: 1.0, gun: false });

export function weaponByIndex(i) {
  return i > 0 && i < WEAPON_LIST.length ? WEAPONS[WEAPON_LIST[i]] : null;
}

// Equipment prices (CS2)
export const EQUIPMENT = {
  vest: { name: 'Kevlar Vest', price: 650 },
  vesthelm: { name: 'Kevlar + Helmet', price: 1000 },
  helmet: { name: 'Helmet upgrade', price: 350 },
  defuser: { name: 'Defuse Kit', price: 400, team: 'CT' },
};

export const MAX_GRENADES = 4; // total grenades you can carry
