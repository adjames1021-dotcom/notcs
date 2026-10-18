// ---------------------------------------------------------------------------
// skeleton.js — where a player's joints are, for a given crouch amount and
// aim pitch. Positions are relative to the feet, X = the way they face,
// Y = their left, Z = up (Hammer units).
//
// BOTH the hitboxes (hitboxes.js: what a bullet can hit, on the server and in
// the browser) and the drawn character (js/render/players.js) are built from
// these joints, so the body you see is exactly the body you can hit.
//
//   * Standing: matches the classic hitbox layout (head top at ~72).
//   * Crouching: hips drop 18 units, knees bend forward, feet stay put.
//   * Aiming up/down: the upper body leans with the aim (20% of the pitch),
//     the head tilts a little more, and the arms (holding the gun) follow the
//     rest of the way, like CS2's models.
// ---------------------------------------------------------------------------

const THIGH = 16, SHIN = 16;
const DUCK_DROP = 18; // 72 - 54
const PELVIS_Z = 36; // everything above this is "upper body"
const SPINE_LEAN = 0.2; // share of the aim pitch the spine follows
const HEAD_TILT = 0.3; // extra share for the head

// Standing, looking straight ahead.
const STAND = {
  ankleL: [0, 4.6, 3], kneeL: [0, 4.6, 19], hipL: [0, 4.6, 35],
  ankleR: [0, -4.6, 3], kneeR: [0, -4.6, 19], hipR: [0, -4.6, 35],
  stomachLow: [0, 0, 36.5], stomachHigh: [0, 0, 45.5],
  chestLow: [0, 0, 46.5], chestHigh: [0.5, 0, 55.5],
  neckLow: [0.5, 0, 57.5], neckHigh: [1.0, 0, 61.0],
  headLow: [1.0, 0, 62.5], headHigh: [2.0, 0, 67.5],
  shoulderL: [1.5, 9.5, 55], elbowL: [6.5, 9.5, 47.5], handL: [13, 5, 45],
  shoulderR: [1.5, -9.5, 55], elbowR: [5.5, -10.5, 47], handR: [15, -3, 47],
};
export const JOINTS = Object.keys(STAND);
const UPPER = JOINTS.filter((k) => !/^(ankle|knee|hip)/.test(k));
const HEAD = ['headLow', 'headHigh'];
const ARMS = ['elbowL', 'handL', 'elbowR', 'handR'];

/** Joint positions for crouch amount `duck` (0..1) and aim `pitch` (degrees, + = down). */
export function skeleton(duck = 0, pitch = 0, out = {}) {
  const drop = DUCK_DROP * duck;
  for (const k of JOINTS) {
    const s = STAND[k];
    const o = out[k] || (out[k] = [0, 0, 0]);
    o[0] = s[0]; o[1] = s[1]; o[2] = s[2];
  }
  // upper body moves down when crouching
  for (const k of UPPER) out[k][2] -= drop;
  // legs: hips drop, feet stay, knees bend forward (two-bone IK)
  for (const side of ['L', 'R']) {
    const hip = out['hip' + side], knee = out['knee' + side], ankle = out['ankle' + side];
    hip[2] -= drop;
    const d = hip[2] - ankle[2];
    const half = d / 2;
    knee[0] = d >= THIGH + SHIN ? 0 : Math.sqrt(Math.max(0, THIGH * THIGH - half * half));
    knee[2] = ankle[2] + half;
  }
  // aim: lean the upper body around the pelvis, then tilt the head
  if (pitch) {
    rotateY(out, UPPER, 0, PELVIS_Z - drop, (pitch * SPINE_LEAN * Math.PI) / 180);
    const n = out.neckHigh;
    rotateY(out, HEAD, n[0], n[2], (pitch * HEAD_TILT * Math.PI) / 180);
    const sx = (out.shoulderL[0] + out.shoulderR[0]) / 2, sz = (out.shoulderL[2] + out.shoulderR[2]) / 2;
    rotateY(out, ARMS, sx, sz, (pitch * (1 - SPINE_LEAN) * Math.PI) / 180);
  }
  return out;
}

// positive angle = forward (looking down)
function rotateY(j, keys, px, pz, a) {
  const c = Math.cos(a), s = Math.sin(a);
  for (const k of keys) {
    const p = j[k];
    const x = p[0] - px, z = p[2] - pz;
    p[0] = px + x * c + z * s;
    p[2] = pz - x * s + z * c;
  }
}
