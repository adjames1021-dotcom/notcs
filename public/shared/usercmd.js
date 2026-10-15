// ---------------------------------------------------------------------------
// usercmd.js — the "user command": everything a client tells the server
// about one 64-tick frame of input. The client never sends positions — only
// these inputs. The server replays them through the same movement code.
// ---------------------------------------------------------------------------

// Button bits (like Source's IN_* flags).
export const IN = {
  FORWARD: 1 << 0,
  BACK: 1 << 1,
  MOVELEFT: 1 << 2,
  MOVERIGHT: 1 << 3,
  JUMP: 1 << 4,
  DUCK: 1 << 5,
  WALK: 1 << 6, // Shift
  ATTACK: 1 << 7, // left mouse
  ATTACK2: 1 << 8, // right mouse
  RELOAD: 1 << 9,
  USE: 1 << 10, // E (plant/defuse, pick up)
  INSPECT: 1 << 11,
  SCORE: 1 << 12, // Tab (no gameplay effect)
};

// One-shot actions carried in cmd.impulse (0 = none).
export const IMPULSE = {
  NONE: 0,
  DROP: 1, // G
  LAST_WEAPON: 2, // Q
  NEXT_WEAPON: 3, // wheel down
  PREV_WEAPON: 4, // wheel up
  SILENCER: 5, // reserved
};

export function createCmd() {
  return {
    num: 0, // client command number (one per tick, always increasing)
    buttons: 0,
    yaw: 0, // degrees, 0 = +X, 90 = +Y (Source convention)
    pitch: 0, // degrees, positive looks DOWN (Source convention)
    select: 0, // weapon slot/id the player wants (0 = no change)
    impulse: 0,
    interp: 0, // server tick (fractional) the client was viewing — lag compensation
  };
}

export function copyCmd(dst, src) {
  dst.num = src.num;
  dst.buttons = src.buttons;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.select = src.select;
  dst.impulse = src.impulse;
  dst.interp = src.interp;
  return dst;
}
