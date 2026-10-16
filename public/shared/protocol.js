// ---------------------------------------------------------------------------
// protocol.js — the binary messages between browser and server.
//
//   Client -> Server:  CMDS      (2 ticks of input per message, 32 msg/s)
//   Server -> Client:  SNAPSHOT  (every tick: your authoritative state for
//                                 reconciliation + what changed about others)
// Rare things (joining, buying, chat, kill feed) are JSON text messages.
// ---------------------------------------------------------------------------

import { ByteWriter, ByteReader } from './bytes.js';
import { createCmd } from './usercmd.js';

export const MSG = {
  CMDS: 1,
  SNAPSHOT: 2,
};

// ---- Field schemas ----------------------------------------------------------
// The predicted state is sent with full precision (f64) so the client can
// tell EXACTLY whether its prediction was right.
// Format: [key, type, count?]
export const MOVE_SCHEMA = [
  ['pos', 'f64', 3],
  ['vel', 'f64', 3],
  ['onGround', 'bool'],
  ['ducked', 'bool'],
  ['duckAmount', 'f64'],
  ['duckSpeed', 'f64'],
  ['stamina', 'f64'],
  ['oldButtons', 'u16'],
  ['fallVelocity', 'f64'],
  ['velocityModifier', 'f64'],
  ['surfaceFriction', 'f64'],
  ['stepTimer', 'f64'],
];

function writeValue(w, type, v) {
  switch (type) {
    case 'f64': w.f64(v); break;
    case 'f32': w.f32(v); break;
    case 'u8': w.u8(v); break;
    case 'i8': w.i8(v); break;
    case 'u16': w.u16(v); break;
    case 'i16': w.i16(v); break;
    case 'u32': w.u32(v); break;
    case 'i32': w.i32(v); break;
    case 'bool': w.bool(v); break;
    default: throw new Error('bad type ' + type);
  }
}
function readValue(r, type) {
  switch (type) {
    case 'f64': return r.f64();
    case 'f32': return r.f32();
    case 'u8': return r.u8();
    case 'i8': return r.i8();
    case 'u16': return r.u16();
    case 'i16': return r.i16();
    case 'u32': return r.u32();
    case 'i32': return r.i32();
    case 'bool': return r.bool();
    default: throw new Error('bad type ' + type);
  }
}

export function writeSchema(w, obj, schema) {
  for (const [key, type, count] of schema) {
    if (count) { const arr = obj[key]; for (let i = 0; i < count; i++) writeValue(w, type, arr[i]); }
    else writeValue(w, type, obj[key]);
  }
}
export function readSchema(r, obj, schema) {
  for (const [key, type, count] of schema) {
    if (count) {
      const arr = obj[key] || (obj[key] = new Array(count));
      for (let i = 0; i < count; i++) arr[i] = readValue(r, type);
    } else obj[key] = readValue(r, type);
  }
  return obj;
}

// ---- Client -> server: commands ------------------------------------------------
export function encodeCmds(cmds) {
  const w = new ByteWriter(16 + cmds.length * 24);
  w.u8(MSG.CMDS).u8(cmds.length);
  for (const c of cmds) {
    w.u32(c.num).u16(c.buttons).f32(c.yaw).f32(c.pitch).u8(c.select).u8(c.impulse).f32(c.interp);
  }
  return w.finish();
}

export function decodeCmds(r) {
  const n = r.u8();
  if (n > 8) throw new Error('too many cmds');
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = createCmd();
    c.num = r.u32();
    c.buttons = r.u16();
    c.yaw = r.f32();
    c.pitch = r.f32();
    c.select = r.u8();
    c.impulse = r.u8();
    c.interp = r.f32();
    out.push(c);
  }
  return out;
}

/** Round view angles exactly the way they'll arrive at the server (float32). */
export function quantizeCmd(c) {
  c.yaw = Math.fround(c.yaw);
  c.pitch = Math.fround(c.pitch);
  c.interp = Math.fround(c.interp);
  return c;
}

// ---- Server -> client: snapshots ---------------------------------------------------
// Entity change mask bits
export const ENT = {
  POS: 1 << 0,
  ANGLES: 1 << 1,
  DUCK_FLAGS: 1 << 2,
  WEAPON: 1 << 3,
  HEALTH: 1 << 4,
  VEL: 1 << 5,
  TEAM: 1 << 6,
  REMOVED: 1 << 7,
};
export const EFLAG = {
  ALIVE: 1 << 0,
  ON_GROUND: 1 << 1,
  DUCKED: 1 << 2,
  WALKING: 1 << 3,
  SCOPED: 1 << 4,
  DEFUSING: 1 << 5,
  PLANTING: 1 << 6,
  RELOADING: 1 << 7,
};

/** The network view of one other player. */
export function createEntityState() {
  return { id: 0, pos: [0, 0, 0], yaw: 0, pitch: 0, duck: 0, flags: 0, weapon: 0, wflags: 0, health: 0, armor: 0, vel: [0, 0, 0], team: 0 };
}

const q16 = (deg) => Math.round(((deg % 360) + 360) % 360 / 360 * 65535) & 0xffff;
const dq16 = (v) => v / 65535 * 360;

/** Compare two entity states and return the change mask. */
export function entityDelta(prev, cur) {
  if (!prev) return ENT.POS | ENT.ANGLES | ENT.DUCK_FLAGS | ENT.WEAPON | ENT.HEALTH | ENT.VEL | ENT.TEAM;
  let m = 0;
  if (Math.fround(prev.pos[0]) !== Math.fround(cur.pos[0]) || Math.fround(prev.pos[1]) !== Math.fround(cur.pos[1]) ||
    Math.fround(prev.pos[2]) !== Math.fround(cur.pos[2])) m |= ENT.POS;
  if (q16(prev.yaw) !== q16(cur.yaw) || Math.round(prev.pitch * 300) !== Math.round(cur.pitch * 300)) m |= ENT.ANGLES;
  if (Math.round(prev.duck * 255) !== Math.round(cur.duck * 255) || prev.flags !== cur.flags) m |= ENT.DUCK_FLAGS;
  if (prev.weapon !== cur.weapon || prev.wflags !== cur.wflags) m |= ENT.WEAPON;
  if (prev.health !== cur.health || prev.armor !== cur.armor) m |= ENT.HEALTH;
  if (Math.round(prev.vel[0]) !== Math.round(cur.vel[0]) || Math.round(prev.vel[1]) !== Math.round(cur.vel[1]) ||
    Math.round(prev.vel[2]) !== Math.round(cur.vel[2])) m |= ENT.VEL;
  if (prev.team !== cur.team) m |= ENT.TEAM;
  return m;
}

export function writeEntity(w, e, mask) {
  w.u8(e.id).u8(mask);
  if (mask & ENT.REMOVED) return;
  if (mask & ENT.POS) w.f32(e.pos[0]).f32(e.pos[1]).f32(e.pos[2]);
  if (mask & ENT.ANGLES) w.u16(q16(e.yaw)).i16(Math.round(e.pitch * 300));
  if (mask & ENT.DUCK_FLAGS) w.u8(Math.round(e.duck * 255)).u8(e.flags);
  if (mask & ENT.WEAPON) w.u8(e.weapon).u8(e.wflags);
  if (mask & ENT.HEALTH) w.u8(Math.max(0, Math.min(255, Math.ceil(e.health)))).u8(Math.max(0, Math.min(255, Math.ceil(e.armor))));
  if (mask & ENT.VEL) w.i16(clamp16(e.vel[0])).i16(clamp16(e.vel[1])).i16(clamp16(e.vel[2]));
  if (mask & ENT.TEAM) w.u8(e.team);
}
const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** Apply an entity update onto a stored state (client side). */
export function readEntity(r, store) {
  const id = r.u8();
  const mask = r.u8();
  if (mask & ENT.REMOVED) return { id, removed: true };
  const e = store.get(id) || { ...createEntityState(), id };
  if (mask & ENT.POS) { e.pos = [r.f32(), r.f32(), r.f32()]; }
  if (mask & ENT.ANGLES) { e.yaw = dq16(r.u16()); e.pitch = r.i16() / 300; }
  if (mask & ENT.DUCK_FLAGS) { e.duck = r.u8() / 255; e.flags = r.u8(); }
  if (mask & ENT.WEAPON) { e.weapon = r.u8(); e.wflags = r.u8(); }
  if (mask & ENT.HEALTH) { e.health = r.u8(); e.armor = r.u8(); }
  if (mask & ENT.VEL) { e.vel = [r.i16(), r.i16(), r.i16()]; }
  if (mask & ENT.TEAM) { e.team = r.u8(); }
  return { id, removed: false, state: { ...e, pos: e.pos.slice(), vel: e.vel.slice() } };
}

export function newReader(arrayBuffer) {
  return new ByteReader(arrayBuffer);
}
export { ByteWriter, ByteReader };
