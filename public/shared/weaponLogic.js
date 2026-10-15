// ---------------------------------------------------------------------------
// weaponLogic.js — what happens when you press fire/reload/switch, for every
// weapon. Runs on the browser (prediction: instant muzzle flash, recoil, ammo)
// and on the server (authority: the bullets that actually do damage), with
// identical inputs -> identical results.
//
// Time inside here is the PLAYER's clock (command number x 1/64 s), so fire
// rates are exact and identical on both sides.
// ---------------------------------------------------------------------------

import { TICK_DT, PLAYER } from './constants.js';
import { IN, IMPULSE } from './usercmd.js';
import {
  WEAPONS, weaponByIndex, RECOIL_SCALE, PUNCH_DECAY_EXP, PUNCH_DECAY_LIN, MAX_GRENADES,
} from './weapons.js';
import { eyeHeight } from './movement.js';
import { makeRng, hashSeed } from './random.js';

const DEG = Math.PI / 180;

// Slot codes for ws.active / ws.last
export const SLOT = { NONE: 0, PRIMARY: 1, SECONDARY: 2, KNIFE: 3, HE: 4, FLASH: 5, SMOKE: 6, FIRE: 7, DECOY: 8, C4: 9, ZEUS: 10 };
const NADE_SLOTS = [SLOT.HE, SLOT.FLASH, SLOT.SMOKE, SLOT.FIRE, SLOT.DECOY];
const NADE_FIELD = { [SLOT.HE]: 'he', [SLOT.FLASH]: 'flash', [SLOT.SMOKE]: 'smoke', [SLOT.FIRE]: 'fire', [SLOT.DECOY]: 'decoy' };
const SILENCER_TIME = 2.0; // TODO: CS2 attach/detach time
const GRENADE_THROW_DELAY = 0.1; // pin is pulled this long before a throw can happen TODO

/** Weapon + inventory state, all plain numbers (sent in snapshots for prediction). */
export function createWeaponState() {
  return {
    pri: 0, priClip: 0, priRes: 0, priFlags: 0,
    sec: 0, secClip: 0, secRes: 0, secFlags: 0,
    knife: 0,
    zeus: 0, zeusClip: 0, zeusReady: 0,
    he: 0, flash: 0, smoke: 0, fire: 0, decoy: 0, // fire = index of molotov/incendiary (count 1)
    c4: 0,
    active: SLOT.NONE, last: SLOT.NONE,
    time: 0,
    nextAttack: 0, nextAttack2: 0, reloadEnd: 0, deployEnd: 0, silencerEnd: 0,
    zoom: 0, rezoom: 0,
    recoilIndex: 0, penalty: 0, punchP: 0, punchY: 0, lastShot: -10, shotsFired: 0,
    burstLeft: 0, burstNext: 0,
    shellState: 0, shellNext: 0,
    cock: 0,
    throwState: 0, throwStrength: 0, throwReady: 0,
    combo: 0,
    shotSeq: 0, // counts every bullet fired (spread seed)
  };
}

// Field schema for the network (see protocol.js). Times need full precision.
export const WEAPON_SCHEMA = [
  ['pri', 'u8'], ['priClip', 'u16'], ['priRes', 'u16'], ['priFlags', 'u8'],
  ['sec', 'u8'], ['secClip', 'u16'], ['secRes', 'u16'], ['secFlags', 'u8'],
  ['knife', 'u8'], ['zeus', 'u8'], ['zeusClip', 'u8'], ['zeusReady', 'f64'],
  ['he', 'u8'], ['flash', 'u8'], ['smoke', 'u8'], ['fire', 'u8'], ['decoy', 'u8'], ['c4', 'u8'],
  ['active', 'u8'], ['last', 'u8'],
  ['time', 'f64'], ['nextAttack', 'f64'], ['nextAttack2', 'f64'], ['reloadEnd', 'f64'], ['deployEnd', 'f64'], ['silencerEnd', 'f64'],
  ['zoom', 'u8'], ['rezoom', 'u8'],
  ['recoilIndex', 'f64'], ['penalty', 'f64'], ['punchP', 'f64'], ['punchY', 'f64'], ['lastShot', 'f64'], ['shotsFired', 'u16'],
  ['burstLeft', 'u8'], ['burstNext', 'f64'],
  ['shellState', 'u8'], ['shellNext', 'f64'],
  ['cock', 'f64'],
  ['throwState', 'u8'], ['throwStrength', 'f64'], ['throwReady', 'f64'],
  ['combo', 'u8'],
  ['shotSeq', 'u32'],
];

export function copyWeaponState(dst, src) {
  for (const [k] of WEAPON_SCHEMA) dst[k] = src[k];
  return dst;
}

export function weaponStateError(a, b) {
  let e = 0;
  for (const [k] of WEAPON_SCHEMA) {
    const d = Math.abs((a[k] || 0) - (b[k] || 0));
    if (d > e) e = d;
  }
  return e;
}

export const FLAG = { SILENCER_ON: 1, BURST: 2 };

// ---- inventory helpers ----------------------------------------------------------
export function slotWeapon(ws, slot) {
  switch (slot) {
    case SLOT.PRIMARY: return weaponByIndex(ws.pri);
    case SLOT.SECONDARY: return weaponByIndex(ws.sec);
    case SLOT.KNIFE: return weaponByIndex(ws.knife);
    case SLOT.ZEUS: return ws.zeus ? WEAPONS.zeus : null;
    case SLOT.HE: return ws.he ? WEAPONS.he : null;
    case SLOT.FLASH: return ws.flash ? WEAPONS.flash : null;
    case SLOT.SMOKE: return ws.smoke ? WEAPONS.smoke : null;
    case SLOT.FIRE: return ws.fire ? weaponByIndex(ws.fire) : null;
    case SLOT.DECOY: return ws.decoy ? WEAPONS.decoy : null;
    case SLOT.C4: return ws.c4 ? WEAPONS.c4 : null;
    default: return null;
  }
}

export function activeWeapon(ws) {
  return slotWeapon(ws, ws.active);
}

export function hasSlot(ws, slot) {
  return !!slotWeapon(ws, slot);
}

/** Clip/reserve accessors for the active gun. */
function ammoKeys(ws) {
  if (ws.active === SLOT.PRIMARY) return ['priClip', 'priRes', 'priFlags'];
  if (ws.active === SLOT.SECONDARY) return ['secClip', 'secRes', 'secFlags'];
  if (ws.active === SLOT.ZEUS) return ['zeusClip', null, null];
  return [null, null, null];
}

export function activeAmmo(ws) {
  const [c, r, f] = ammoKeys(ws);
  return { clip: c ? ws[c] : 0, reserve: r ? ws[r] : 0, flags: f ? ws[f] : 0 };
}

export function grenadeCount(ws) {
  return (ws.he ? 1 : 0) + ws.flash + (ws.smoke ? 1 : 0) + (ws.fire ? 1 : 0) + (ws.decoy ? 1 : 0);
}

/**
 * Give a weapon. Returns { ok, dropped: {id, clip, reserve, flags} | null }.
 * Picking up/buying a primary while you have one drops the old one.
 */
export function giveWeapon(ws, id, ammo = null) {
  const def = WEAPONS[id];
  if (!def) return { ok: false, dropped: null };
  let dropped = null;
  const clip = ammo ? ammo.clip : def.clip;
  const reserve = ammo ? ammo.reserve : def.reserve;
  const flags = ammo ? ammo.flags : (def.silencer ? FLAG.SILENCER_ON : 0);
  switch (def.slot) {
    case 'primary':
      if (ws.pri) dropped = { id: weaponByIndex(ws.pri).id, clip: ws.priClip, reserve: ws.priRes, flags: ws.priFlags };
      ws.pri = def.index; ws.priClip = clip; ws.priRes = reserve; ws.priFlags = flags;
      break;
    case 'secondary':
      if (ws.sec) dropped = { id: weaponByIndex(ws.sec).id, clip: ws.secClip, reserve: ws.secRes, flags: ws.secFlags };
      ws.sec = def.index; ws.secClip = clip; ws.secRes = reserve; ws.secFlags = flags;
      break;
    case 'knife':
      ws.knife = def.index;
      break;
    case 'zeus':
      if (ws.zeus) return { ok: false, dropped: null };
      ws.zeus = 1; ws.zeusClip = ammo ? ammo.clip : 1; ws.zeusReady = 0;
      break;
    case 'grenade': {
      if (grenadeCount(ws) >= MAX_GRENADES) return { ok: false, dropped: null };
      if (id === 'flash') { if (ws.flash >= def.nade.max) return { ok: false, dropped: null }; ws.flash++; }
      else if (id === 'molotov' || id === 'incendiary') { if (ws.fire) return { ok: false, dropped: null }; ws.fire = def.index; }
      else { if (ws[id]) return { ok: false, dropped: null }; ws[id] = 1; }
      break;
    }
    case 'c4':
      ws.c4 = 1;
      break;
    default:
      return { ok: false, dropped: null };
  }
  return { ok: true, dropped };
}

/** Starting equipment: knife + default pistol for your team. */
export function defaultLoadout(ws, team) {
  Object.assign(ws, createWeaponState());
  giveWeapon(ws, team === 'CT' ? 'knife_ct' : 'knife_t');
  giveWeapon(ws, team === 'CT' ? 'usps' : 'glock');
  ws.active = SLOT.SECONDARY;
  ws.last = SLOT.KNIFE;
}

/** Remove a slot's weapon (dropping, throwing). Returns what was removed. */
export function removeSlot(ws, slot) {
  const def = slotWeapon(ws, slot);
  if (!def) return null;
  let item = { id: def.id, clip: 0, reserve: 0, flags: 0 };
  switch (slot) {
    case SLOT.PRIMARY: item = { id: def.id, clip: ws.priClip, reserve: ws.priRes, flags: ws.priFlags }; ws.pri = ws.priClip = ws.priRes = ws.priFlags = 0; break;
    case SLOT.SECONDARY: item = { id: def.id, clip: ws.secClip, reserve: ws.secRes, flags: ws.secFlags }; ws.sec = ws.secClip = ws.secRes = ws.secFlags = 0; break;
    case SLOT.ZEUS: item = { id: 'zeus', clip: ws.zeusClip, reserve: 0, flags: 0 }; ws.zeus = ws.zeusClip = 0; ws.zeusReady = 0; break;
    case SLOT.FLASH: ws.flash--; break;
    case SLOT.FIRE: ws.fire = 0; break;
    case SLOT.C4: ws.c4 = 0; break;
    case SLOT.KNIFE: return null; // can't lose the knife
    default: if (NADE_FIELD[slot]) ws[NADE_FIELD[slot]] = 0;
  }
  return item;
}

// ---- movement speed ---------------------------------------------------------------
export function weaponMaxSpeed(ws) {
  const def = activeWeapon(ws);
  if (!def) return PLAYER.DEFAULT_MAX_SPEED;
  if (ws.zoom > 0 && def.scope && def.scope.speed) return def.scope.speed;
  return def.speed;
}

// ---- switching ------------------------------------------------------------------------
const ORDER = [SLOT.PRIMARY, SLOT.SECONDARY, SLOT.KNIFE, SLOT.ZEUS, ...NADE_SLOTS, SLOT.C4];

export function switchTo(ws, slot) {
  if (!hasSlot(ws, slot) || slot === ws.active) return false;
  ws.last = ws.active;
  ws.active = slot;
  const def = activeWeapon(ws);
  ws.deployEnd = ws.time + (def.deploy || 1);
  ws.nextAttack = Math.max(ws.nextAttack, ws.deployEnd);
  ws.nextAttack2 = Math.max(ws.nextAttack2, ws.deployEnd);
  ws.reloadEnd = 0; ws.shellState = 0; ws.zoom = 0; ws.rezoom = 0; ws.burstLeft = 0; ws.cock = 0;
  ws.throwState = 0; ws.silencerEnd = 0;
  return true;
}

function bestSlot(ws) {
  for (const s of ORDER) if (hasSlot(ws, s)) return s;
  return SLOT.NONE;
}

function handleSelection(ws, cmd) {
  if (cmd.select) {
    const s = cmd.select;
    if (s === 1) switchTo(ws, SLOT.PRIMARY);
    else if (s === 2) switchTo(ws, SLOT.SECONDARY);
    else if (s === 3) {
      // knife and Zeus share slot 3 (press again to toggle)
      if (ws.active === SLOT.KNIFE && ws.zeus) switchTo(ws, SLOT.ZEUS);
      else switchTo(ws, SLOT.KNIFE);
    } else if (s === 4) {
      // cycle through your grenades
      const owned = NADE_SLOTS.filter((n) => hasSlot(ws, n));
      if (owned.length) {
        const i = owned.indexOf(ws.active);
        switchTo(ws, owned[(i + 1) % owned.length]);
      }
    } else if (s === 5) switchTo(ws, SLOT.C4);
  }
  if (cmd.impulse === IMPULSE.LAST_WEAPON) {
    if (hasSlot(ws, ws.last)) switchTo(ws, ws.last);
  } else if (cmd.impulse === IMPULSE.NEXT_WEAPON || cmd.impulse === IMPULSE.PREV_WEAPON) {
    const owned = ORDER.filter((s) => hasSlot(ws, s));
    if (owned.length) {
      const i = owned.indexOf(ws.active);
      const d = cmd.impulse === IMPULSE.NEXT_WEAPON ? 1 : owned.length - 1;
      switchTo(ws, owned[(i + d + owned.length) % owned.length]);
    }
  }
  if (!hasSlot(ws, ws.active)) {
    const s = bestSlot(ws);
    if (s) { ws.active = SLOT.NONE; switchTo(ws, s); }
  }
}

// ---- accuracy -----------------------------------------------------------------------
/** Current inaccuracy in milliradians (what the dynamic crosshair shows). */
export function currentInaccuracy(ws, ps, def = activeWeapon(ws)) {
  if (!def || !def.acc) return 0;
  const a = def.acc;
  const scoped = ws.zoom > 0 && def.scope;
  const d = ps.ducked ? 1 : ps.duckAmount;
  let inacc = scoped ? a.scoped + (a.scopedCrouch - a.scoped) * d : a.stand + (a.crouch - a.stand) * d;
  // moving: accurate below 34% of max speed, fully inaccurate near max speed
  const speed = Math.hypot(ps.vel[0], ps.vel[1]);
  const ms = def.speed;
  const lo = ms * PLAYER.DUCK_MODIFIER, hi = ms * 0.95;
  const moveScale = Math.max(0, Math.min(1, (speed - lo) / (hi - lo)));
  inacc += moveScale * a.move;
  // in the air (the SSG 08 is very accurate at the top of a jump)
  if (!ps.onGround) {
    const vz = Math.min(1, Math.abs(ps.vel[2]) / 250);
    const apex = def.airApex ?? 0.6;
    inacc += a.air * (apex + (1 - apex) * vz * vz);
  }
  inacc += ws.penalty;
  return inacc;
}

function recoveryTime(def, ps) {
  const a = def.acc;
  return ps.ducked ? (a.recoveryCrouch || a.recovery) : a.recovery;
}

// ---- the per-tick weapon update ----------------------------------------------------------------
/**
 * Run weapons for one command (after movement).
 * @returns out = { shots: [...], knife: null|{...}, throw: null|{...}, drop: null|item,
 *                  sounds: [...], reloadStart, emptyClick, ... }
 */
export function processWeapon(ps, ws, cmd, ctx) {
  const out = ctx.weaponOut || (ctx.weaponOut = {});
  out.shots = []; out.knife = null; out.throw = null; out.drop = null; out.reloadStart = false; out.reloadDone = false;
  out.emptyClick = false; out.zoomChanged = false; out.silencerToggle = false; out.burstToggle = false; out.deployed = false;
  out.plant = false;

  ws.time = cmd.num * TICK_DT;
  const buttons = ctx.frozen ? (cmd.buttons & ~(IN.ATTACK | IN.ATTACK2)) : cmd.buttons;
  const old = ctx.oldButtons ?? 0;
  const pressed1 = (buttons & IN.ATTACK) && !(old & IN.ATTACK);
  const pressed2 = (buttons & IN.ATTACK2) && !(old & IN.ATTACK2);
  const t = ws.time;

  // Zeus recharge (CS2)
  if (ws.zeus && ws.zeusClip === 0 && ws.zeusReady > 0 && t >= ws.zeusReady) { ws.zeusClip = 1; ws.zeusReady = 0; }

  const prevActive = ws.active;
  if (ws.throwState === 0) handleSelection(ws, cmd);
  if (ws.active !== prevActive) out.deployed = true;

  if (cmd.impulse === IMPULSE.DROP && ws.throwState === 0) {
    const slot = ws.active;
    if (slot === SLOT.PRIMARY || slot === SLOT.SECONDARY || slot === SLOT.C4 || slot === SLOT.ZEUS || NADE_FIELD[slot]) {
      out.drop = removeSlot(ws, slot);
      out.drop.slot = slot;
      const s = hasSlot(ws, ws.last) ? ws.last : bestSlot(ws);
      ws.active = SLOT.NONE;
      if (s) switchTo(ws, s);
    }
  }

  const def = activeWeapon(ws);
  decay(ws, ps, def);
  if (!def) return out;

  if (def.gun) gunLogic(ps, ws, cmd, ctx, def, buttons, pressed1, pressed2, out);
  else if (def.cls === 'knife') knifeLogic(ps, ws, cmd, def, buttons, out);
  else if (def.cls === 'grenade') grenadeLogic(ps, ws, cmd, def, buttons, old, out);
  else if (def.cls === 'c4') out.plant = !!(buttons & IN.ATTACK) || !!(buttons & IN.USE);
  return out;
}

function decay(ws, ps, def) {
  const dt = TICK_DT;
  // inaccuracy from firing decays to 10% over the weapon's recovery time
  if (ws.penalty > 0 && def && def.acc) {
    const rt = recoveryTime(def, ps);
    ws.penalty *= Math.pow(0.1, dt / rt);
    if (ws.penalty < 0.001) ws.penalty = 0;
  }
  const firing = def && def.cycle && (ws.time - ws.lastShot) < def.cycle * 1.5 + dt;
  if (!firing) {
    // recoil pattern resets when you stop shooting
    if (ws.recoilIndex > 0) {
      const rt = def && def.acc ? recoveryTime(def, ps) : 0.35;
      ws.recoilIndex *= Math.exp(-dt / (rt * 0.45));
      if (ws.recoilIndex < 0.1) ws.recoilIndex = 0;
    }
    ws.shotsFired = 0;
  }
  // aim punch slides back to zero (exponential + linear like CS) once you
  // stop firing. Mid-spray it holds, so the pattern is exactly the table.
  if (!firing && (ws.punchP !== 0 || ws.punchY !== 0)) {
    const k = 1;
    const f = Math.exp(-PUNCH_DECAY_EXP * dt * k);
    ws.punchP *= f; ws.punchY *= f;
    const len = Math.hypot(ws.punchP, ws.punchY);
    const lin = PUNCH_DECAY_LIN * dt * k;
    if (len <= lin) { ws.punchP = 0; ws.punchY = 0; } else { const s = (len - lin) / len; ws.punchP *= s; ws.punchY *= s; }
  }
}

/** Forward/right/up vectors for Source angles (degrees). */
export function angleVectors(pitch, yaw) {
  const p = pitch * DEG, y = yaw * DEG;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y);
  return {
    forward: [cp * cy, cp * sy, -sp],
    right: [sy, -cy, 0],
    up: [sp * cy, sp * sy, cp],
  };
}

export function eyePos(ps) {
  return [ps.pos[0], ps.pos[1], ps.pos[2] + eyeHeight(ps)];
}

function gunLogic(ps, ws, cmd, ctx, def, buttons, pressed1, pressed2, out) {
  const t = ws.time;
  const [clipKey, resKey, flagKey] = ammoKeys(ws);
  const deployed = t >= ws.deployEnd;

  // --- reload completion
  if (ws.reloadEnd > 0 && t >= ws.reloadEnd) {
    const need = def.clip - ws[clipKey];
    const take = Math.min(need, ws[resKey]);
    ws[clipKey] += take; ws[resKey] -= take;
    ws.reloadEnd = 0;
    out.reloadDone = true;
  }
  // --- shotgun shell-by-shell reload
  if (ws.shellState > 0 && t >= ws.shellNext) {
    const sr = def.shellReload;
    if (ws.shellState === 1) { ws.shellState = 2; ws.shellNext = t + sr.shell; }
    else if (ws[clipKey] < def.clip && ws[resKey] > 0) {
      ws[clipKey]++; ws[resKey]--;
      out.reloadDone = true;
      if (ws[clipKey] >= def.clip || ws[resKey] <= 0) { ws.shellState = 0; ws.nextAttack = Math.max(ws.nextAttack, t + sr.end * 0.5); }
      else ws.shellNext = t + sr.shell;
    } else ws.shellState = 0;
  }
  // --- silencer finished attaching/removing
  if (ws.silencerEnd > 0 && t >= ws.silencerEnd) {
    ws[flagKey] ^= FLAG.SILENCER_ON;
    ws.silencerEnd = 0;
  }
  // --- AWP/SSG re-zoom after the bolt cycles
  if (ws.rezoom && t >= ws.nextAttack) { ws.zoom = ws.rezoom; ws.rezoom = 0; out.zoomChanged = true; }

  const reloading = ws.reloadEnd > 0;
  const busy = reloading || ws.silencerEnd > 0 || !deployed;

  // --- right click: scope / silencer / burst mode / R8 fan
  if (pressed2 && deployed && !reloading) {
    if (def.scope) {
      ws.zoom = (ws.zoom + 1) % (def.scope.fov.length + 1);
      ws.rezoom = 0;
      out.zoomChanged = true;
    } else if (def.silencer && ws.silencerEnd === 0 && clipKey) {
      ws.silencerEnd = t + SILENCER_TIME;
      ws.nextAttack = Math.max(ws.nextAttack, ws.silencerEnd);
      out.silencerToggle = true;
    } else if (def.burst && clipKey) {
      ws[flagKey] ^= FLAG.BURST;
      out.burstToggle = true;
    }
  }

  // --- reload button (or empty clip)
  const clip = ws[clipKey];
  const canReload = resKey && ws[resKey] > 0 && clip < def.clip && !reloading && ws.shellState === 0 && deployed && ws.silencerEnd === 0;
  const wantReload = (buttons & IN.RELOAD) || (clip === 0 && (buttons & IN.ATTACK) && t >= ws.nextAttack);
  if (wantReload && canReload) {
    ws.zoom = 0; ws.rezoom = 0; ws.burstLeft = 0; ws.cock = 0;
    if (def.shellReload) { ws.shellState = 1; ws.shellNext = t + def.shellReload.start; }
    else ws.reloadEnd = t + def.reload;
    out.reloadStart = true;
    return;
  }
  if (def.id === 'zeus' && clip === 0) return;

  // --- shooting
  const isBurst = def.burst && (ws[flagKey] & FLAG.BURST);
  let fire = false;
  let fan = false;
  if (ws.burstLeft > 0) {
    if (t >= ws.burstNext && clip > 0 && !busy) fire = true;
    if (clip === 0) ws.burstLeft = 0;
  } else if (def.revolver) {
    // R8: hold to cock then fire; right click fans fast and inaccurate
    if ((buttons & IN.ATTACK) && t >= ws.nextAttack && !busy && clip > 0) {
      if (ws.cock === 0) ws.cock = t;
      if (t - ws.cock >= def.revolver.cock) fire = true;
    } else if (!(buttons & IN.ATTACK)) ws.cock = 0;
    if (!fire && (buttons & IN.ATTACK2) && t >= ws.nextAttack2 && t >= ws.nextAttack && !busy && clip > 0) { fire = true; fan = true; }
  } else {
    const trigger = def.auto ? (buttons & IN.ATTACK) : pressed1;
    // shotguns can interrupt shell reloading to fire
    if (trigger && ws.shellState > 0 && clip > 0) ws.shellState = 0;
    if (trigger && t >= ws.nextAttack && !busy) {
      if (clip > 0) { fire = true; if (isBurst) ws.burstLeft = def.burst.count; }
      else if (pressed1) { out.emptyClick = true; ws.nextAttack = t + 0.2; }
    }
  }
  if (!fire) return;

  // ---- fire one shot ----
  const inaccMrad = currentInaccuracy(ws, ps, def) + (fan ? def.acc.fan : 0);
  const silenced = !!(def.silencer && (ws[flagKey] & FLAG.SILENCER_ON));
  const spreadMrad = def.acc.spread * (silenced ? 0.85 : 1);
  const pitch = cmd.pitch + ws.punchP * RECOIL_SCALE;
  const yaw = cmd.yaw + ws.punchY * RECOIL_SCALE;
  const { forward, right, up } = angleVectors(pitch, yaw);
  const origin = eyePos(ps);
  const dirs = [];
  const seed = hashSeed(ctx.playerId || 0, cmd.num, ws.shotSeq);
  const rng = makeRng(seed);
  for (let k = 0; k < def.pellets; k++) {
    const th1 = rng() * Math.PI * 2, r1 = rng();
    const th2 = rng() * Math.PI * 2, r2 = rng();
    const x = (Math.cos(th1) * r1 * inaccMrad + Math.cos(th2) * r2 * spreadMrad) / 1000;
    const y = (Math.sin(th1) * r1 * inaccMrad + Math.sin(th2) * r2 * spreadMrad) / 1000;
    const d = [forward[0] + right[0] * x + up[0] * y, forward[1] + right[1] * x + up[1] * y, forward[2] + right[2] * x + up[2] * y];
    const l = Math.hypot(d[0], d[1], d[2]);
    dirs.push([d[0] / l, d[1] / l, d[2] / l]);
  }
  ws.shotSeq = (ws.shotSeq + 1) >>> 0;
  ws[clipKey]--;
  out.shots.push({ weapon: def.id, origin, dirs, silenced, pitch: cmd.pitch, yaw: cmd.yaw, seed });

  // accuracy penalty for the NEXT shot
  if (def.negev) ws.penalty = Math.max(0, ws.penalty + (ws.shotsFired < 8 ? def.acc.fire : -def.acc.fire * 0.6));
  else ws.penalty += def.acc.fire;
  if (ws.penalty > 200) ws.penalty = 200;

  // recoil: follow the fixed pattern
  const pat = def.recoil;
  const idx = Math.min(pat.length - 1, Math.floor(ws.recoilIndex));
  const [kickUp, kickRight] = pat[idx];
  ws.punchP -= kickUp; // negative pitch = up
  ws.punchY -= kickRight; // negative yaw = right
  ws.recoilIndex += 1;
  ws.shotsFired = Math.min(65535, ws.shotsFired + 1);

  // timing (keeps the exact fire rate even though ticks are 15.6 ms)
  let cycle = def.cycle;
  if (isBurst) cycle = def.burst.cycle;
  if (fan) cycle = def.revolver.fanCycle;
  if (ws.burstLeft > 0) {
    ws.burstLeft--;
    if (ws.burstLeft > 0) { ws.burstNext = t + def.burst.interval; ws.nextAttack = t + def.burst.cycle; }
    else ws.nextAttack = t + def.burst.cycle;
  } else {
    ws.nextAttack = (t - ws.nextAttack < TICK_DT && ws.nextAttack > 0) ? ws.nextAttack + cycle : t + cycle;
  }
  if (fan) ws.nextAttack2 = t + def.revolver.fanCycle;
  if (def.revolver) ws.cock = 0;
  ws.lastShot = t;
  // bolt-action snipers unscope after each shot and re-zoom when ready
  if (def.scope && def.cls === 'sniper' && !def.auto && ws.zoom > 0) { ws.rezoom = ws.zoom; ws.zoom = 0; out.zoomChanged = true; }
  // the Zeus recharges after use (CS2)
  if (def.id === 'zeus' && ws.zeusClip === 0) ws.zeusReady = t + def.recharge;
}

function knifeLogic(ps, ws, cmd, def, buttons, out) {
  const t = ws.time;
  if (t < ws.deployEnd) return;
  const k = def.knife;
  let attack = null;
  if ((buttons & IN.ATTACK2) && t >= ws.nextAttack2 && t >= ws.nextAttack) {
    attack = { kind: 'stab', ...k.stab };
    ws.nextAttack = ws.nextAttack2 = t + k.stab.cycle;
    ws.combo = 0;
  } else if ((buttons & IN.ATTACK) && t >= ws.nextAttack) {
    const combo = ws.combo > 0 && (t - ws.lastShot) < k.slash.comboWindow + k.slash.cycle;
    attack = { kind: 'slash', range: k.slash.range, damage: combo ? k.slash.followUp : k.slash.damage, backstab: k.slash.backstab };
    ws.nextAttack = t + (combo ? k.slash.cycle : k.slash.firstCycle);
    ws.nextAttack2 = Math.max(ws.nextAttack2, t + 0.5);
    ws.combo = combo ? ws.combo + 1 : 1;
  }
  if (!attack) return;
  ws.lastShot = t;
  const { forward } = angleVectors(cmd.pitch, cmd.yaw);
  out.knife = { weapon: def.id, origin: eyePos(ps), dir: forward, ...attack };
}

// Grenades: hold left (strong throw), right (underhand) or both (medium), release to throw.
function grenadeLogic(ps, ws, cmd, def, buttons, old, out) {
  const t = ws.time;
  if (t < ws.deployEnd) return;
  const b1 = !!(buttons & IN.ATTACK), b2 = !!(buttons & IN.ATTACK2);
  if (ws.throwState === 0) {
    if (b1 || b2) { ws.throwState = 1; ws.throwReady = t + GRENADE_THROW_DELAY; }
    return;
  }
  if (ws.throwState === 1) {
    // strength follows the buttons you're holding
    if (b1 || b2) { ws.throwStrength = b1 && b2 ? 0.5 : b1 ? 1 : 0; return; }
    if (t < ws.throwReady) return; // released too early: throw as soon as the pin is out
    const strength = ws.throwStrength;
    const { forward } = angleVectors(cmd.pitch, cmd.yaw);
    out.throw = {
      weapon: def.id, origin: eyePos(ps), pitch: cmd.pitch, yaw: cmd.yaw, strength,
      vel: [ps.vel[0], ps.vel[1], ps.vel[2]], forward,
    };
    ws.throwState = 0;
    const slot = ws.active;
    removeSlot(ws, slot);
    ws.lastShot = t;
    // after throwing: next grenade of any kind, else last weapon
    const next = hasSlot(ws, slot) ? slot : hasSlot(ws, ws.last) ? ws.last : bestSlot(ws);
    ws.active = SLOT.NONE;
    if (next) switchTo(ws, next);
    void old;
  }
}

/** Damage-taken aim punch + tagging (called by the server when you're hit). */
export function applyHitEffects(ps, ws, damage, tag) {
  ws.punchP -= Math.min(5, damage * 0.06); // TODO: tune CS2 aim punch
  ps.velocityModifier = Math.min(ps.velocityModifier, tag);
}
