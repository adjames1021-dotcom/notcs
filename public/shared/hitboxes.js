// ---------------------------------------------------------------------------
// hitboxes.js — per-body-part hitboxes (capsules) for a player, and ray tests.
// The drawn player model (render/players.js) uses the same skeleton.
// Coordinates relative to the player's feet, X = facing direction.
// ---------------------------------------------------------------------------

import { HITGROUP } from './weapons.js';
import { skeleton } from './skeleton.js';

// [hitgroup, from joint, to joint, radius]. The joints come from skeleton.js,
// which the drawn character uses too, so the hitboxes follow the body when it
// crouches (knees bend) or aims up and down (upper body leans).
// TODO: tune sizes to match CS2 hitboxes / your player models.
const CAPSULES = [
  [HITGROUP.HEAD, 'headLow', 'headHigh', 4.4],
  [HITGROUP.NECK, 'neckLow', 'neckHigh', 3.0],
  [HITGROUP.CHEST, 'chestLow', 'chestHigh', 7.6],
  [HITGROUP.STOMACH, 'stomachLow', 'stomachHigh', 7.0],
  [HITGROUP.LEFTARM, 'shoulderL', 'elbowL', 2.8],
  [HITGROUP.LEFTARM, 'elbowL', 'handL', 2.6],
  [HITGROUP.RIGHTARM, 'shoulderR', 'elbowR', 2.8],
  [HITGROUP.RIGHTARM, 'elbowR', 'handR', 2.6],
  [HITGROUP.LEFTLEG, 'hipL', 'kneeL', 4.3],
  [HITGROUP.LEFTLEG, 'kneeL', 'ankleL', 4.3],
  [HITGROUP.RIGHTLEG, 'hipR', 'kneeR', 4.3],
  [HITGROUP.RIGHTLEG, 'kneeR', 'ankleR', 4.3],
];
const joints = {};

/**
 * World-space capsules for a player.
 * @param pos feet position, yaw degrees, duck 0..1, pitch degrees (+ = looking down)
 */
export function playerHitboxes(pos, yaw, duck, out = [], pitch = 0) {
  const y = (yaw * Math.PI) / 180;
  const c = Math.cos(y), s = Math.sin(y);
  skeleton(duck, pitch, joints);
  const tf = (p, o) => {
    o[0] = pos[0] + p[0] * c - p[1] * s;
    o[1] = pos[1] + p[0] * s + p[1] * c;
    o[2] = pos[2] + p[2];
    return o;
  };
  out.length = CAPSULES.length;
  for (let i = 0; i < CAPSULES.length; i++) {
    const [group, a, b, r] = CAPSULES[i];
    const box = out[i] || (out[i] = { group, a: [0, 0, 0], b: [0, 0, 0], r });
    box.group = group; box.r = r;
    tf(joints[a], box.a); tf(joints[b], box.b);
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
export function rayPlayer(start, dir, maxDist, pos, yaw, duck, scratch, pad = 0, pitch = 0) {
  if (!rayNearPlayer(start, dir, maxDist, pos, duck)) return null;
  const caps = playerHitboxes(pos, yaw, duck, scratch, pitch);
  let best = null;
  for (const cap of caps) {
    const t = rayCapsule(start, dir, cap, maxDist, pad);
    if (t >= 0 && (!best || t < best.t)) best = { t, group: cap.group };
  }
  return best;
}
