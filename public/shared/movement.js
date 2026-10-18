// ---------------------------------------------------------------------------
// movement.js — Source/CS-style player movement. THE most important file for
// game feel. It's a careful port of the logic in Valve's Source SDK
// gamemovement.cpp (WalkMove, AirMove, TryPlayerMove, StepMove, ...), with
// the CS:GO/CS2 additions (accelerate scale, stamina, bunnyhop cap, duck).
//
// It runs on the browser (prediction) and the server (authority) with the
// exact same inputs, so both compute the exact same result.
//
// Coordinates: Hammer units, +Z up. Angles: degrees, Source convention.
// ---------------------------------------------------------------------------

import { CVARS, PLAYER, HULL_STAND, HULL_DUCK, TICK_DT, COLLISION } from './constants.js';
import { createTrace } from './collision.js';
import { IN } from './usercmd.js';

const DEG = Math.PI / 180;
const MAX_CLIP_PLANES = 5;
const NON_JUMP_VELOCITY = 140;
const DUCK_DELTA = PLAYER.AIR_DUCK_SHIFT; // origin shift when crouching in the air (9)
const COORD_RESOLUTION = 1 / 32;

/** All the per-player movement state. Plain numbers so it's easy to copy/send. */
export function createPlayerState() {
  return {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    onGround: false,
    ducked: false, // using the 54-unit crouch hull
    duckAmount: 0, // 0 = standing, 1 = fully crouched (drives eye height + speed)
    duckSpeed: PLAYER.DUCK_SPEED_IDEAL,
    stamina: 0,
    oldButtons: 0,
    fallVelocity: 0,
    velocityModifier: 1, // < 1 right after being shot ("tagging")
    surfaceFriction: 1,
    stepTimer: 0,
  };
}

export function copyPlayerState(dst, src) {
  dst.pos[0] = src.pos[0]; dst.pos[1] = src.pos[1]; dst.pos[2] = src.pos[2];
  dst.vel[0] = src.vel[0]; dst.vel[1] = src.vel[1]; dst.vel[2] = src.vel[2];
  dst.onGround = src.onGround;
  dst.ducked = src.ducked;
  dst.duckAmount = src.duckAmount;
  dst.duckSpeed = src.duckSpeed;
  dst.stamina = src.stamina;
  dst.oldButtons = src.oldButtons;
  dst.fallVelocity = src.fallVelocity;
  dst.velocityModifier = src.velocityModifier;
  dst.surfaceFriction = src.surfaceFriction;
  dst.stepTimer = src.stepTimer;
  return dst;
}

/** Largest difference between two states (used to detect mispredictions). */
export function playerStateError(a, b) {
  let e = 0;
  for (let i = 0; i < 3; i++) {
    e = Math.max(e, Math.abs(a.pos[i] - b.pos[i]), Math.abs(a.vel[i] - b.vel[i]) * 0.1);
  }
  if (a.onGround !== b.onGround || a.ducked !== b.ducked) e = Math.max(e, 1);
  e = Math.max(e, Math.abs(a.duckAmount - b.duckAmount) * 10, Math.abs(a.stamina - b.stamina) * 0.1,
    Math.abs(a.velocityModifier - b.velocityModifier) * 10);
  return e;
}

export function getHull(ps) {
  return ps.ducked ? HULL_DUCK : HULL_STAND;
}

/** Eye height above the feet, smoothly blended while crouching. */
export function eyeHeight(ps) {
  return PLAYER.EYE_STAND + (PLAYER.EYE_DUCK - PLAYER.EYE_STAND) * ps.duckAmount;
}

// Scratch objects reused every call (JS is single threaded, so this is safe).
const tr = createTrace();
const trStep = createTrace();
const tmpA = [0, 0, 0];
const tmpB = [0, 0, 0];

function traceHull(ctx, ps, start, end, out) {
  const h = getHull(ps);
  return ctx.world.traceBox(start, end, h.mins, h.maxs, out, ctx.boxes || null);
}

/**
 * Run one tick of movement.
 * @param ps   player state (modified in place)
 * @param cmd  user command (buttons + view angles)
 * @param ctx  { world, dt?, maxSpeed?, frozen?, boxes? }
 *             maxSpeed = the held weapon's movement speed (knife = 250)
 * @returns events { jumped, landSpeed, fallDamage, footstep }
 */
export function playerMove(ps, cmd, ctx) {
  const ev = ctx.events || (ctx.events = {});
  ev.jumped = false; ev.landSpeed = 0; ev.fallDamage = 0; ev.footstep = false;
  const dt = ctx.dt ?? TICK_DT;
  // During freeze time you can look around and crouch, nothing else.
  const buttons = ctx.frozen ? (cmd.buttons & (IN.DUCK | IN.WALK)) : cmd.buttons;

  reduceTimers(ps, dt);
  if (!ps.onGround) ps.fallVelocity = -ps.vel[2];
  handleDuck(ps, buttons, ctx, dt);

  let fmove = 0, smove = 0;
  if (buttons & IN.FORWARD) fmove += CVARS.cl_forwardspeed;
  if (buttons & IN.BACK) fmove -= CVARS.cl_forwardspeed;
  if (buttons & IN.MOVERIGHT) smove += CVARS.cl_sidespeed;
  if (buttons & IN.MOVELEFT) smove -= CVARS.cl_sidespeed;

  const maxspeed = computeMaxSpeed(ps, buttons, ctx);
  const spd = Math.hypot(fmove, smove);
  if (spd > maxspeed && spd > 0) {
    const ratio = maxspeed / spd;
    fmove *= ratio; smove *= ratio;
  }

  fullWalkMove(ps, buttons, cmd.yaw, fmove, smove, maxspeed, ctx, dt, ev);
  footsteps(ps, dt, ev);
  ps.oldButtons = buttons;
  return ev;
}

/** The speed you're allowed to move at right now. */
export function computeMaxSpeed(ps, buttons, ctx) {
  let m = ctx.maxSpeed ?? PLAYER.DEFAULT_MAX_SPEED;
  let mod = 1;
  if (buttons & IN.WALK) mod = PLAYER.WALK_MODIFIER;
  const duckMod = 1 + (PLAYER.DUCK_MODIFIER - 1) * ps.duckAmount;
  if (duckMod < mod) mod = duckMod;
  m *= mod * ps.velocityModifier;
  return Math.min(m, CVARS.sv_maxspeed);
}

function reduceTimers(ps, dt) {
  if (ps.stamina > 0) ps.stamina = Math.max(0, ps.stamina - CVARS.sv_staminarecoveryrate * dt);
  if (ps.duckSpeed < PLAYER.DUCK_SPEED_IDEAL) {
    ps.duckSpeed = Math.min(PLAYER.DUCK_SPEED_IDEAL, ps.duckSpeed + PLAYER.DUCK_SPEED_RECOVERY * dt);
  }
  if (ps.velocityModifier < 1) ps.velocityModifier = Math.min(1, ps.velocityModifier + PLAYER.TAG_RECOVERY_RATE * dt);
}

// --- Crouching ---------------------------------------------------------------
// On the ground the eyes lower smoothly over 10 ticks, then the hull shrinks
// from the top. In the air the hull shrinks at once and your feet come up 9
// units (CS2) — that's what makes crouch-jumping reach higher boxes.
function handleDuck(ps, buttons, ctx, dt) {
  const released = !(buttons & IN.DUCK) && (ps.oldButtons & IN.DUCK);
  if (released) ps.duckSpeed = Math.max(PLAYER.DUCK_SPEED_MIN, ps.duckSpeed - PLAYER.DUCK_SPAM_PENALTY);
  const rate = ps.duckSpeed * PLAYER.DUCK_RATE_SCALE * dt;

  if (buttons & IN.DUCK) {
    if (ps.ducked) { ps.duckAmount = 1; return; }
    if (ps.onGround) {
      ps.duckAmount = ps.duckAmount + rate >= 1 - 1e-9 ? 1 : ps.duckAmount + rate; // (0.1 x 10 is 0.9999999)
      if (ps.duckAmount >= 1) ps.ducked = true;
    } else {
      // Keep the eyes exactly where they are while the feet come up.
      ps.pos[2] += DUCK_DELTA * (1 - ps.duckAmount);
      ps.ducked = true;
      ps.duckAmount = 1;
    }
    return;
  }

  // Crouch released: stand up if there's room.
  if (ps.ducked) {
    if (ps.onGround) {
      if (!ctx.world.testBox(ps.pos, HULL_STAND.mins, HULL_STAND.maxs, ctx.boxes || null)) ps.ducked = false;
    } else {
      tmpA[0] = ps.pos[0]; tmpA[1] = ps.pos[1]; tmpA[2] = ps.pos[2] - DUCK_DELTA;
      if (!ctx.world.testBox(tmpA, HULL_STAND.mins, HULL_STAND.maxs, ctx.boxes || null)) {
        ps.pos[2] -= DUCK_DELTA; // feet drop down, head stays
        ps.ducked = false;
        ps.duckAmount = 0;
      }
    }
  }
  if (!ps.ducked && ps.duckAmount > 0) ps.duckAmount = ps.duckAmount - rate <= 1e-9 ? 0 : ps.duckAmount - rate;
}

// --- Main walk/air loop (Source FullWalkMove) --------------------------------
function fullWalkMove(ps, buttons, yaw, fmove, smove, maxspeed, ctx, dt, ev) {
  startGravity(ps, dt);

  if (buttons & IN.JUMP) checkJumpButton(ps, ctx, dt, ev);

  if (ps.onGround) {
    ps.vel[2] = 0;
    friction(ps, dt);
  }
  checkVelocity(ps);

  if (ps.onGround) walkMove(ps, yaw, fmove, smove, maxspeed, ctx, dt);
  else airMove(ps, yaw, fmove, smove, maxspeed, ctx, dt);

  categorizePosition(ps, ctx);
  checkVelocity(ps);
  finishGravity(ps, dt);
  if (ps.onGround) ps.vel[2] = 0;
  checkFalling(ps, ev);
}

function startGravity(ps, dt) {
  ps.vel[2] -= CVARS.sv_gravity * 0.5 * dt;
}

function finishGravity(ps, dt) {
  ps.vel[2] -= CVARS.sv_gravity * 0.5 * dt;
  checkVelocity(ps);
}

function checkVelocity(ps) {
  const max = CVARS.sv_maxvelocity;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(ps.vel[i])) ps.vel[i] = 0;
    if (!Number.isFinite(ps.pos[i])) ps.pos[i] = 0;
    if (ps.vel[i] > max) ps.vel[i] = max;
    else if (ps.vel[i] < -max) ps.vel[i] = -max;
  }
}

// --- Jumping -------------------------------------------------------------------
function checkJumpButton(ps, ctx, dt, ev) {
  if (ctx.frozen) return;
  if (!ps.onGround) return; // can't jump in the air
  if (ps.oldButtons & IN.JUMP) return; // must re-press jump (no auto-bhop)

  if (!CVARS.sv_enablebunnyhopping) preventBunnyJumping(ps, ctx);

  ps.onGround = false;
  // Same impulse standing or crouched. The quarter tick of gravity makes the
  // arc match CS2's measured jump (286.37 u/s after this tick, apex 55.82).
  const J = CVARS.sv_jump_impulse;
  ps.vel[2] = J - CVARS.sv_gravity * dt * 0.25;

  // Jumping again right after landing gives a lower jump.
  if (ps.stamina > 0) {
    const ratio = (CVARS.sv_staminamax - ps.stamina) / CVARS.sv_staminamax;
    ps.vel[2] *= ratio;
  }
  ps.stamina = Math.min(CVARS.sv_staminamax, ps.stamina + CVARS.sv_staminajumpcost * J);

  finishGravity(ps, dt); // half a tick of gravity before this tick's move
  ev.jumped = true;
}

// Speed is capped to 1.1x max speed whenever you jump (CS default), so
// bhopping keeps your speed but can't build up huge speed like in CS 1.6.
function preventBunnyJumping(ps, ctx) {
  const base = (ctx.maxSpeed ?? PLAYER.DEFAULT_MAX_SPEED) * ps.velocityModifier;
  const maxscaled = PLAYER.BUNNYJUMP_MAX_SPEED_FACTOR * base;
  if (maxscaled <= 0) return;
  const spd = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
  if (spd <= maxscaled) return;
  const f = maxscaled / spd;
  ps.vel[0] *= f; ps.vel[1] *= f; ps.vel[2] *= f;
}

// --- Ground friction -----------------------------------------------------------
function friction(ps, dt) {
  const speed = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
  if (speed < 0.1) return;
  const fric = CVARS.sv_friction * ps.surfaceFriction;
  const control = speed < CVARS.sv_stopspeed ? CVARS.sv_stopspeed : speed;
  const drop = control * fric * dt;
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  if (newspeed !== speed) {
    const s = newspeed / speed;
    ps.vel[0] *= s; ps.vel[1] *= s; ps.vel[2] *= s;
  }
}

// --- Acceleration --------------------------------------------------------------
function accelerate(ps, dx, dy, wishspeed, accel, dt) {
  const current = ps.vel[0] * dx + ps.vel[1] * dy;
  const add = wishspeed - current;
  if (add <= 0) return;
  // CS:GO/CS2 scale acceleration by at least 250, so walking, crouching and
  // heavy weapons still change speed quickly (counter-strafing works).
  let accelspeed = accel * dt * Math.max(PLAYER.ACCEL_MIN_SCALE, wishspeed) * ps.surfaceFriction;
  if (accelspeed > add) accelspeed = add;
  ps.vel[0] += accelspeed * dx;
  ps.vel[1] += accelspeed * dy;
}

// Air strafing: you can only add up to 30 units/s in the wish direction, but
// accel uses the full wish speed — turning while strafing gains speed.
function airAccelerate(ps, dx, dy, wishspeed, accel, dt) {
  let wishspd = wishspeed;
  if (wishspd > CVARS.sv_air_max_wishspeed) wishspd = CVARS.sv_air_max_wishspeed;
  const current = ps.vel[0] * dx + ps.vel[1] * dy;
  const add = wishspd - current;
  if (add <= 0) return;
  let accelspeed = accel * wishspeed * dt * ps.surfaceFriction;
  if (accelspeed > add) accelspeed = add;
  ps.vel[0] += accelspeed * dx;
  ps.vel[1] += accelspeed * dy;
}

function wishFromInput(yaw, fmove, smove, maxspeed) {
  const y = yaw * DEG;
  const cy = Math.cos(y), sy = Math.sin(y);
  // forward = (cos, sin, 0), right = (sin, -cos, 0)
  const wx = cy * fmove + sy * smove;
  const wy = sy * fmove - cy * smove;
  let wishspeed = Math.hypot(wx, wy);
  let dx = 0, dy = 0;
  if (wishspeed > 0) { dx = wx / wishspeed; dy = wy / wishspeed; }
  if (wishspeed > maxspeed) wishspeed = maxspeed;
  return { dx, dy, wishspeed };
}

// --- Ground movement (Source WalkMove) -------------------------------------
function walkMove(ps, yaw, fmove, smove, maxspeed, ctx, dt) {
  const w = wishFromInput(yaw, fmove, smove, maxspeed);
  ps.vel[2] = 0;
  accelerate(ps, w.dx, w.dy, w.wishspeed, CVARS.sv_accelerate, dt);
  ps.vel[2] = 0;

  const spd = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
  if (spd < 1) {
    ps.vel[0] = ps.vel[1] = ps.vel[2] = 0;
    return;
  }

  const dest = tmpB;
  dest[0] = ps.pos[0] + ps.vel[0] * dt;
  dest[1] = ps.pos[1] + ps.vel[1] * dt;
  dest[2] = ps.pos[2];
  traceHull(ctx, ps, ps.pos, dest, tr);
  if (tr.fraction === 1) {
    ps.pos[0] = dest[0]; ps.pos[1] = dest[1]; ps.pos[2] = dest[2];
    stayOnGround(ps, ctx);
    return;
  }
  stepMove(ps, [dest[0], dest[1], dest[2]], ctx, dt);
  stayOnGround(ps, ctx);
}

// --- Air movement ------------------------------------------------------------------
function airMove(ps, yaw, fmove, smove, maxspeed, ctx, dt) {
  const w = wishFromInput(yaw, fmove, smove, maxspeed);
  airAccelerate(ps, w.dx, w.dy, w.wishspeed, CVARS.sv_airaccelerate, dt);
  tryPlayerMove(ps, ctx, dt);
}

// --- Slide along walls (Source TryPlayerMove) ------------------------------------
function clipVelocity(inV, normal, out, overbounce) {
  const backoff = (inV[0] * normal[0] + inV[1] * normal[1] + inV[2] * normal[2]) * overbounce;
  for (let i = 0; i < 3; i++) out[i] = inV[i] - normal[i] * backoff;
  // make sure we aren't still moving through the plane
  const adjust = out[0] * normal[0] + out[1] * normal[1] + out[2] * normal[2];
  if (adjust < 0) for (let i = 0; i < 3; i++) out[i] -= normal[i] * adjust;
}

function tryPlayerMove(ps, ctx, dt) {
  const numbumps = 4;
  const planes = [];
  const primal = [ps.vel[0], ps.vel[1], ps.vel[2]];
  const original = [ps.vel[0], ps.vel[1], ps.vel[2]];
  const newVel = [0, 0, 0];
  const end = [0, 0, 0];
  let timeLeft = dt;
  let allFraction = 0;
  let blocked = 0;

  for (let bump = 0; bump < numbumps; bump++) {
    if (ps.vel[0] === 0 && ps.vel[1] === 0 && ps.vel[2] === 0) break;
    end[0] = ps.pos[0] + ps.vel[0] * timeLeft;
    end[1] = ps.pos[1] + ps.vel[1] * timeLeft;
    end[2] = ps.pos[2] + ps.vel[2] * timeLeft;
    traceHull(ctx, ps, ps.pos, end, tr);
    allFraction += tr.fraction;

    if (tr.fraction > 0) {
      ps.pos[0] = tr.endpos[0]; ps.pos[1] = tr.endpos[1]; ps.pos[2] = tr.endpos[2];
      original[0] = ps.vel[0]; original[1] = ps.vel[1]; original[2] = ps.vel[2];
      planes.length = 0;
    }
    if (tr.fraction === 1) break;

    if (tr.normal[2] > 0.7) blocked |= 1; // floor
    if (tr.normal[2] === 0) blocked |= 2; // wall/step

    timeLeft -= timeLeft * tr.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      ps.vel[0] = ps.vel[1] = ps.vel[2] = 0;
      break;
    }
    planes.push([tr.normal[0], tr.normal[1], tr.normal[2]]);

    if (planes.length === 1 && !ps.onGround) {
      // First impact in the air: just slide along it.
      clipVelocity(original, planes[0], newVel, 1);
      ps.vel[0] = original[0] = newVel[0];
      ps.vel[1] = original[1] = newVel[1];
      ps.vel[2] = original[2] = newVel[2];
    } else {
      let i;
      for (i = 0; i < planes.length; i++) {
        clipVelocity(original, planes[i], ps.vel, 1);
        let j;
        for (j = 0; j < planes.length; j++) {
          if (j !== i) {
            const d = ps.vel[0] * planes[j][0] + ps.vel[1] * planes[j][1] + ps.vel[2] * planes[j][2];
            if (d < 0) break; // still moving into another plane
          }
        }
        if (j === planes.length) break; // this clip works for every plane
      }
      if (i === planes.length) {
        // Go along the crease between two planes.
        if (planes.length !== 2) {
          ps.vel[0] = ps.vel[1] = ps.vel[2] = 0;
          break;
        }
        const a = planes[0], b = planes[1];
        let cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
        const l = Math.hypot(cx, cy, cz) || 1;
        cx /= l; cy /= l; cz /= l;
        const d = cx * ps.vel[0] + cy * ps.vel[1] + cz * ps.vel[2];
        ps.vel[0] = cx * d; ps.vel[1] = cy * d; ps.vel[2] = cz * d;
      }
      // If we'd now move backwards, stop dead (prevents jitter in corners).
      const d = ps.vel[0] * primal[0] + ps.vel[1] * primal[1] + ps.vel[2] * primal[2];
      if (d <= 0) {
        ps.vel[0] = ps.vel[1] = ps.vel[2] = 0;
        break;
      }
    }
  }
  if (allFraction === 0) ps.vel[0] = ps.vel[1] = ps.vel[2] = 0;
  return blocked;
}

// --- Stairs (Source StepMove): try the move normally AND raised by 18 units,
// keep whichever got further. This is the 18-unit step-up.
function stepMove(ps, dest, ctx, dt) {
  const startPos = [ps.pos[0], ps.pos[1], ps.pos[2]];
  const startVel = [ps.vel[0], ps.vel[1], ps.vel[2]];

  // 1) slide move along the ground
  tryPlayerMove(ps, ctx, dt);
  const downPos = [ps.pos[0], ps.pos[1], ps.pos[2]];
  const downVel = [ps.vel[0], ps.vel[1], ps.vel[2]];

  // 2) reset, move up a stair height, slide move, move back down
  ps.pos[0] = startPos[0]; ps.pos[1] = startPos[1]; ps.pos[2] = startPos[2];
  ps.vel[0] = startVel[0]; ps.vel[1] = startVel[1]; ps.vel[2] = startVel[2];
  const up = [ps.pos[0], ps.pos[1], ps.pos[2] + CVARS.sv_stepsize + COLLISION.DIST_EPSILON];
  traceHull(ctx, ps, ps.pos, up, trStep);
  if (!trStep.startsolid) { ps.pos[0] = trStep.endpos[0]; ps.pos[1] = trStep.endpos[1]; ps.pos[2] = trStep.endpos[2]; }
  tryPlayerMove(ps, ctx, dt);

  const down = [ps.pos[0], ps.pos[1], ps.pos[2] - CVARS.sv_stepsize - COLLISION.DIST_EPSILON];
  traceHull(ctx, ps, ps.pos, down, trStep);
  // Didn't land on walkable ground: use the plain slide result.
  if (trStep.normal[2] < 0.7) {
    ps.pos[0] = downPos[0]; ps.pos[1] = downPos[1]; ps.pos[2] = downPos[2];
    ps.vel[0] = downVel[0]; ps.vel[1] = downVel[1]; ps.vel[2] = downVel[2];
    return;
  }
  if (!trStep.startsolid) { ps.pos[0] = trStep.endpos[0]; ps.pos[1] = trStep.endpos[1]; ps.pos[2] = trStep.endpos[2]; }

  const downDist = (downPos[0] - startPos[0]) ** 2 + (downPos[1] - startPos[1]) ** 2;
  const upDist = (ps.pos[0] - startPos[0]) ** 2 + (ps.pos[1] - startPos[1]) ** 2;
  if (downDist > upDist) {
    ps.pos[0] = downPos[0]; ps.pos[1] = downPos[1]; ps.pos[2] = downPos[2];
    ps.vel[0] = downVel[0]; ps.vel[1] = downVel[1]; ps.vel[2] = downVel[2];
  } else {
    ps.vel[2] = downVel[2];
  }
}

// Keep the player glued to the ground when walking down stairs/slopes.
function stayOnGround(ps, ctx) {
  const start = [ps.pos[0], ps.pos[1], ps.pos[2] + 2];
  const end = [ps.pos[0], ps.pos[1], ps.pos[2] - CVARS.sv_stepsize];
  traceHull(ctx, ps, ps.pos, start, trStep);
  start[0] = trStep.endpos[0]; start[1] = trStep.endpos[1]; start[2] = trStep.endpos[2];
  traceHull(ctx, ps, start, end, trStep);
  if (trStep.fraction > 0 && trStep.fraction < 1 && !trStep.startsolid && trStep.normal[2] >= 0.7) {
    const delta = Math.abs(ps.pos[2] - trStep.endpos[2]);
    if (delta > 0.5 * COORD_RESOLUTION) {
      ps.pos[0] = trStep.endpos[0]; ps.pos[1] = trStep.endpos[1]; ps.pos[2] = trStep.endpos[2];
    }
  }
}

// --- Are we standing on something? (Source CategorizePosition) -------------
function categorizePosition(ps, ctx) {
  ps.surfaceFriction = 1;
  const zvel = ps.vel[2];
  if (zvel > NON_JUMP_VELOCITY) {
    ps.onGround = false;
    return;
  }
  const point = [ps.pos[0], ps.pos[1], ps.pos[2] - 2];
  const h = getHull(ps);
  let ok = touchGround(ctx, ps.pos, point, h.mins, h.maxs);
  if (!ok) ok = touchGroundInQuadrants(ctx, ps.pos, point, h.mins, h.maxs);
  if (!ok) {
    ps.onGround = false;
    if (zvel > 0) ps.surfaceFriction = 0.25;
  } else {
    ps.onGround = true;
    ps.vel[2] = 0;
  }
}

function touchGround(ctx, start, end, mins, maxs) {
  ctx.world.traceBox(start, end, mins, maxs, trStep, ctx.boxes || null);
  return trStep.hit && trStep.normal[2] >= 0.7;
}

// If the full box only touches a steep edge, test the four quarter-boxes —
// one of them may be standing on flat ground (stops "edge snagging").
function touchGroundInQuadrants(ctx, start, end, mins, maxs) {
  const quads = [
    [[mins[0], mins[1], mins[2]], [Math.min(0, maxs[0]), Math.min(0, maxs[1]), maxs[2]]],
    [[Math.max(0, mins[0]), Math.max(0, mins[1]), mins[2]], [maxs[0], maxs[1], maxs[2]]],
    [[mins[0], Math.max(0, mins[1]), mins[2]], [Math.min(0, maxs[0]), maxs[1], maxs[2]]],
    [[Math.max(0, mins[0]), mins[1], mins[2]], [maxs[0], Math.min(0, maxs[1]), maxs[2]]],
  ];
  for (const [qmin, qmax] of quads) {
    if (touchGround(ctx, start, end, qmin, qmax)) return true;
  }
  return false;
}

// --- Landing: fall damage and landing penalty -------------------------------
function checkFalling(ps, ev) {
  if (!ps.onGround || ps.fallVelocity <= 0) return;
  const fv = ps.fallVelocity;
  ev.landSpeed = fv;
  if (fv > PLAYER.MAX_SAFE_FALL_SPEED) {
    const dmgPerSpeed = 100 / (PLAYER.FATAL_FALL_SPEED - PLAYER.MAX_SAFE_FALL_SPEED);
    ev.fallDamage = (fv - PLAYER.MAX_SAFE_FALL_SPEED) * dmgPerSpeed * PLAYER.FALL_DAMAGE_MULTIPLIER * CVARS.sv_falldamage_scale;
  }
  ps.stamina = Math.min(CVARS.sv_staminamax, ps.stamina + CVARS.sv_staminalandcost * fv);
  ps.fallVelocity = 0;
}

function footsteps(ps, dt, ev) {
  if (!ps.onGround) return;
  const speed = Math.hypot(ps.vel[0], ps.vel[1]);
  if (speed < PLAYER.FOOTSTEP_MIN_SPEED) { ps.stepTimer = 0; return; }
  ps.stepTimer -= dt;
  if (ps.stepTimer <= 0) {
    ev.footstep = true;
    ps.stepTimer = Math.min(0.5, Math.max(0.25, 0.35 * (250 / speed)));
  }
}

/** Free-flying camera for dead players / spectators. */
export function spectatorMove(ps, cmd, dt = TICK_DT) {
  const speed = (cmd.buttons & IN.WALK) ? 300 : 900;
  const y = cmd.yaw * DEG, p = cmd.pitch * DEG;
  const fx = Math.cos(p) * Math.cos(y), fy = Math.cos(p) * Math.sin(y), fz = -Math.sin(p);
  const rx = Math.sin(y), ry = -Math.cos(y);
  let f = 0, s = 0, u = 0;
  if (cmd.buttons & IN.FORWARD) f += 1;
  if (cmd.buttons & IN.BACK) f -= 1;
  if (cmd.buttons & IN.MOVERIGHT) s += 1;
  if (cmd.buttons & IN.MOVELEFT) s -= 1;
  if (cmd.buttons & IN.JUMP) u += 1;
  if (cmd.buttons & IN.DUCK) u -= 1;
  const tx = fx * f + rx * s, ty = fy * f + ry * s, tz = fz * f + u;
  const l = Math.hypot(tx, ty, tz);
  const k = l > 0 ? speed / l : 0;
  // smooth acceleration
  const blend = Math.min(1, dt * 8);
  ps.vel[0] += (tx * k - ps.vel[0]) * blend;
  ps.vel[1] += (ty * k - ps.vel[1]) * blend;
  ps.vel[2] += (tz * k - ps.vel[2]) * blend;
  ps.pos[0] += ps.vel[0] * dt;
  ps.pos[1] += ps.vel[1] * dt;
  ps.pos[2] += ps.vel[2] * dt;
}
