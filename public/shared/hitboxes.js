// ---------------------------------------------------------------------------
// hitboxes.js — per-body-part hitboxes (capsules) for a player, and ray tests.
// The placeholder player model in render/players.js is built to match these.
// Coordinates relative to the player's feet, X = facing direction.
// ---------------------------------------------------------------------------

import { HITGROUP } from './weapons.js';

// [hitgroup, from[x,y,z], to[x,y,z], radius] for a STANDING player.
// TODO: tune sizes to match CS2 hitboxes / your player models.
const STAND = [
  [HITGROUP.HEAD, [1.0, 0, 62.5], [2.0, 0, 67.5], 4.4],
  [HITGROUP.NECK, [0.5, 0, 57.5], [1.0, 0, 61.0], 3.0],
  [HITGROUP.CHEST, [0, 0, 46.5], [0.5, 0, 55.5], 7.6],
  [HITGROUP.STOMACH, [0, 0, 36.5], [0, 0, 45.5], 7.0],
  [HITGROUP.LEFTARM, [1.5, 9.5, 55], [13, 5, 45], 2.8],
  [HITGROUP.RIGHTARM, [1.5, -9.5, 55], [15, -3, 47], 2.8],
  [HITGROUP.LEFTLEG, [0, 4.6, 3], [0, 4.6, 35], 4.3],
  [HITGROUP.RIGHTLEG, [0, -4.6, 3], [0, -4.6, 35], 4.3],
];

const LEG_TOP = 36;
const DUCK_DROP = 18; // 72 - 54

/**
 * World-space capsules for a player.
 * @param pos feet position, yaw degrees, duck 0..1
 */
export function playerHitboxes(pos, yaw, duck, out = []) {
  const y = (yaw * Math.PI) / 180;
  const c = Math.cos(y), s = Math.sin(y);
  const legScale = (LEG_TOP - DUCK_DROP * duck) / LEG_TOP;
  const drop = DUCK_DROP * duck;
  const tf = (p, o) => {
    let z = p[2];
    // crouching: legs shorten, everything above them moves down
    z = z <= LEG_TOP ? z * legScale : z - drop;
    o[0] = pos[0] + p[0] * c - p[1] * s;
    o[1] = pos[1] + p[0] * s + p[1] * c;
    o[2] = pos[2] + z;
    return o;
  };
  out.length = STAND.length;
  for (let i = 0; i < STAND.length; i++) {
    const [group, a, b, r] = STAND[i];
    const box = out[i] || (out[i] = { group, a: [0, 0, 0], b: [0, 0, 0], r });
    box.group = group; box.r = r;
    tf(a, box.a); tf(b, box.b);
  }
  return out;
}

/** Bounding sphere test first (cheap). Center ~ chest, radius ~ 44. */
export function rayNearPlayer(start, dir, maxDist, pos, duck) {
  const cz = pos[2] + 36 - 9 * duck;
  const ox = pos[0] - start[0], oy = pos[1] - start[1], oz = cz - start[2];
  const t = ox * dir[0] + oy * dir[1] + oz * dir[2];
  if (t < -48 || t > maxDist + 48) return false;
  const dx = ox - dir[0] * t, dy = oy - dir[1] * t, dz = oz - dir[2] * t;
  return dx * dx + dy * dy + dz * dz < 48 * 48;
}

/**
 * Ray vs capsule. dir must be normalized. Returns distance or -1.
 * `pad` widens the capsule (used for the knife so it's not too precise).
 */
export function rayCapsule(start, dir, cap, maxDist, pad = 0) {
  const r = cap.r + pad;
  const ax = cap.a[0], ay = cap.a[1], az = cap.a[2];
  const bax = cap.b[0] - ax, bay = cap.b[1] - ay, baz = cap.b[2] - az;
  const oax = start[0] - ax, oay = start[1] - ay, oaz = start[2] - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dir[0] + bay * dir[1] + baz * dir[2];
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dir[0] * oax + dir[1] * oay + dir[2] * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0 && A > 1e-9) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0 && t <= maxDist) return t;
  }
  // caps (spheres at both ends)
  let best = -1;
  for (const [cx, cy, cz] of [[ax, ay, az], [cap.b[0], cap.b[1], cap.b[2]]]) {
    const ocx = start[0] - cx, ocy = start[1] - cy, ocz = start[2] - cz;
    const b = ocx * dir[0] + ocy * dir[1] + ocz * dir[2];
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    const hh = b * b - c;
    if (hh < 0) continue;
    const t = -b - Math.sqrt(hh);
    if (t >= 0 && t <= maxDist && (best < 0 || t < best)) best = t;
  }
  return best;
}

/** Closest hitbox a ray hits on one player: { t, group } or null. */
export function rayPlayer(start, dir, maxDist, pos, yaw, duck, scratch, pad = 0) {
  if (!rayNearPlayer(start, dir, maxDist, pos, duck)) return null;
  const caps = playerHitboxes(pos, yaw, duck, scratch);
  let best = null;
  for (const cap of caps) {
    const t = rayCapsule(start, dir, cap, maxDist, pad);
    if (t >= 0 && (!best || t < best.t)) best = { t, group: cap.group };
  }
  return best;
}
