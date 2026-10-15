// ---------------------------------------------------------------------------
// constants.js — numbers shared by the browser AND the server.
//
// Everything here is in Hammer units (1 unit ~ 1 inch), Z is up, angles are
// degrees, time is seconds. Change a value here and both the client
// prediction and the authoritative server pick it up, so they stay identical.
// ---------------------------------------------------------------------------

// Fixed simulation rate. CS2 servers run at 64 ticks per second.
export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;

// Movement console variables, named after their CS2/Source equivalents.
export const CVARS = {
  sv_accelerate: 5.5,
  sv_friction: 5.2,
  sv_stopspeed: 80,
  sv_airaccelerate: 12,
  sv_air_max_wishspeed: 30,
  sv_gravity: 800,
  sv_maxspeed: 320,
  sv_maxvelocity: 3500,
  sv_jump_impulse: 301.993377411544, // sqrt(2 * 800 * 57)
  sv_stepsize: 18,
  sv_falldamage_scale: 1,
  // When false, jumping caps your speed at 1.1x your max speed (CS default).
  sv_enablebunnyhopping: false,
  // Stamina: landing / jumping briefly slows you and lowers the next jump.
  sv_staminamax: 80,
  sv_staminajumpcost: 0.08, // TODO: CS2 value; scaled by jump velocity here
  sv_staminalandcost: 0.05, // TODO: CS2 value; scaled by fall velocity here
  sv_staminarecoveryrate: 60,
  cl_forwardspeed: 450,
  cl_sidespeed: 450,
};

// Player size and speeds.
export const PLAYER = {
  HALF_WIDTH: 16, // 32 units wide
  HEIGHT_STAND: 72,
  HEIGHT_DUCK: 54,
  EYE_STAND: 64,
  EYE_DUCK: 46,
  WALK_MODIFIER: 0.52, // Shift
  DUCK_MODIFIER: 0.34, // Ctrl
  DEFAULT_MAX_SPEED: 250, // knife speed; weapons override this
  // Accelerate() never uses less than this as its scale (CS:GO/CS2 behaviour,
  // makes walking/crouching/heavy weapons accelerate snappily).
  ACCEL_MIN_SCALE: 250, // TODO: verify against CS2
  BUNNYJUMP_MAX_SPEED_FACTOR: 1.1,
  DUCK_SPEED_IDEAL: 8, // duck amount per second (full crouch in ~0.125 s) TODO: tune
  DUCK_SPEED_MIN: 1.5, // duck-spam penalty floor TODO: tune
  DUCK_SPAM_PENALTY: 2, // subtracted per crouch press TODO: tune
  DUCK_SPEED_RECOVERY: 3, // per second back toward ideal TODO: tune
  // Fall damage (CS:GO/CS2 game rules).
  MAX_SAFE_FALL_SPEED: 580, // ~210 units drop
  FATAL_FALL_SPEED: 1100,
  FALL_DAMAGE_MULTIPLIER: 1.25,
  FALL_PUNCH_THRESHOLD: 350,
  // Footsteps are audible above this horizontal speed (walking is silent).
  FOOTSTEP_MIN_SPEED: 135, // TODO: verify against CS2
  // Being shot slows you down ("tagging"); recovers at this rate per second.
  TAG_RECOVERY_RATE: 0.4, // TODO: tune
};

// Collision tuning.
export const COLLISION = {
  DIST_EPSILON: 0.03125, // Source keeps boxes this far from surfaces
  GRID_CELL: 128, // broadphase grid cell size (units)
};

// Precomputed hulls (origin is at the feet, centred).
export const HULL_STAND = {
  mins: [-PLAYER.HALF_WIDTH, -PLAYER.HALF_WIDTH, 0],
  maxs: [PLAYER.HALF_WIDTH, PLAYER.HALF_WIDTH, PLAYER.HEIGHT_STAND],
};
export const HULL_DUCK = {
  mins: [-PLAYER.HALF_WIDTH, -PLAYER.HALF_WIDTH, 0],
  maxs: [PLAYER.HALF_WIDTH, PLAYER.HALF_WIDTH, PLAYER.HEIGHT_DUCK],
};
