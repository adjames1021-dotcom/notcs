// ---------------------------------------------------------------------------
// grenades.js — thrown grenades and what they do (server side, shared math).
//
//   HE        explodes after 1.5 s, damage falls off with distance, needs
//             line of sight, armor reduces it
//   Flashbang explodes after 1.5 s, blinds players who can see it — longer
//             if you're looking at it
//   Smoke     pops when it stops rolling; the cloud flows around walls
//             (voxel flood fill), blocks vision for 18 s, puts out fire
//   Molotov / Incendiary  bursts on hitting the ground; fire spreads over the
//             floor for 7 s, hurts anyone standing in it; smoke puts it out
//   Decoy     makes fake gunshot sounds for 15 s
//
// Throwing follows CS: left click = full throw, right click = underhand,
// both = medium. The grenade inherits some of your running speed.
// ---------------------------------------------------------------------------

import { TICK_DT, TICK_RATE } from './constants.js';
import { createTrace } from './collision.js';
import { WEAPONS, HITGROUP } from './weapons.js';
import { computeDamage } from './bullets.js';
import { angleVectors } from './weaponLogic.js';
import { makeRng, hashSeed } from './random.js';

export const NADE_GRAVITY = 0.4 * 800;
const ELASTICITY = 0.45;
const NADE_HULL = { mins: [-2, -2, -2], maxs: [2, 2, 2] };
export const THROW_SPEED = 750;
export const SMOKE_VOXEL = 16;
const SMOKE_MAX_VOXELS = 1400; // TODO: tune to CS2 smoke volume
const SMOKE_MAX_STEPS = 11; // how far (in voxels) the cloud can flow
const FIRE_CELL = 24;
const FIRE_MAX_CELLS = 40;
const FIRE_MAX_STEPS = 6;
const FIRE_DPS = 40; // TODO: CS2 molotov damage per second
const HE_RADIUS = 350;

const tr = createTrace();
const tr2 = createTrace();

/** CS-style throw: velocity of a grenade leaving your hand. */
export function throwVelocity(pitch, yaw, strength, playerVel) {
  // grenades are thrown 10 degrees higher than you aim (CS)
  const p = pitch >= 0 ? -10 + pitch * (100 / 90) : -10 + pitch * (80 / 90);
  const { forward } = angleVectors(p, yaw);
  const speed = THROW_SPEED * (strength * 0.7 + 0.3);
  return {
    forward,
    vel: [forward[0] * speed + playerVel[0] * 1.25, forward[1] * speed + playerVel[1] * 1.25, forward[2] * speed + playerVel[2] * 1.25],
  };
}

/**
 * Advance a bouncing projectile one tick. Shared by grenades and dropped
 * weapons (with different bounciness). Returns 'ground' | 'wall' | null.
 */
export function stepProjectile(world, p, dt = TICK_DT, elasticity = ELASTICITY, boxes = null) {
  if (p.resting) return null;
  p.vel[2] -= NADE_GRAVITY * dt;
  let timeLeft = dt;
  let hitKind = null;
  for (let bump = 0; bump < 3 && timeLeft > 0; bump++) {
    const end = [p.pos[0] + p.vel[0] * timeLeft, p.pos[1] + p.vel[1] * timeLeft, p.pos[2] + p.vel[2] * timeLeft];
    world.traceBox(p.pos, end, NADE_HULL.mins, NADE_HULL.maxs, tr, boxes);
    p.pos[0] = tr.endpos[0]; p.pos[1] = tr.endpos[1]; p.pos[2] = tr.endpos[2];
    if (!tr.hit) break;
    timeLeft -= timeLeft * tr.fraction;
    const n = tr.normal;
    // reflect (overbounce 2) then lose energy
    const d = p.vel[0] * n[0] + p.vel[1] * n[1] + p.vel[2] * n[2];
    if (d < 0) {
      p.vel[0] = (p.vel[0] - 2 * d * n[0]) * elasticity;
      p.vel[1] = (p.vel[1] - 2 * d * n[1]) * elasticity;
      p.vel[2] = (p.vel[2] - 2 * d * n[2]) * elasticity;
    }
    p.bounces = (p.bounces || 0) + 1;
    hitKind = n[2] > 0.7 ? 'ground' : 'wall';
    if (n[2] > 0.7) {
      const sp2 = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1] + p.vel[2] * p.vel[2];
      if (sp2 < 30 * 30) {
        p.vel[0] = p.vel[1] = p.vel[2] = 0;
        p.resting = true;
        break;
      }
    }
  }
  if (!Number.isFinite(p.pos[2])) p.resting = true;
  return hitKind;
}

/** Is there a clear line between two points (world only)? */
function clearLine(world, a, b) {
  world.traceRay(a, b, tr2);
  return !tr2.hit;
}

// ---- smoke cloud: flood fill through open space ---------------------------------
/**
 * Returns voxel offsets [dx,dy,dz,...] (in voxels, relative to the centre
 * voxel) in the order the smoke reaches them. Deterministic.
 */
export function smokeVoxels(world, center) {
  const c = [center[0], center[1], center[2] + SMOKE_VOXEL * 0.5];
  const key = (x, y, z) => ((x + 128) << 16) | ((y + 128) << 8) | (z + 128);
  const seen = new Set([key(0, 0, 0)]);
  const out = [0, 0, 0];
  let frontier = [[0, 0, 0]];
  const half = SMOKE_VOXEL * 0.45;
  const boxMin = [-half, -half, -half], boxMax = [half, half, half];
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];
  for (let step = 0; step < SMOKE_MAX_STEPS && frontier.length && out.length / 3 < SMOKE_MAX_VOXELS; step++) {
    const next = [];
    for (const [x, y, z] of frontier) {
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nz > 6 || nz < -4) continue; // keeps the cloud roughly CS-shaped
        if (Math.hypot(nx, ny, nz * 1.4) > SMOKE_MAX_STEPS) continue;
        const k = key(nx, ny, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        const p = [c[0] + nx * SMOKE_VOXEL, c[1] + ny * SMOKE_VOXEL, c[2] + nz * SMOKE_VOXEL];
        if (world.testBox(p, boxMin, boxMax)) continue;
        const from = [c[0] + x * SMOKE_VOXEL, c[1] + y * SMOKE_VOXEL, c[2] + z * SMOKE_VOXEL];
        if (!clearLine(world, from, p)) continue;
        out.push(nx, ny, nz);
        next.push([nx, ny, nz]);
        if (out.length / 3 >= SMOKE_MAX_VOXELS) break;
      }
      if (out.length / 3 >= SMOKE_MAX_VOXELS) break;
    }
    frontier = next;
  }
  return { origin: c, voxels: out };
}

/** Does a line pass through an active smoke? (flashes and bots use this) */
export function lineThroughSmoke(smokes, a, b) {
  for (const s of smokes) {
    if (!s.set) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const steps = Math.ceil(len / (SMOKE_VOXEL * 0.5));
    let inside = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const vx = Math.round((a[0] + (b[0] - a[0]) * t - s.origin[0]) / SMOKE_VOXEL);
      const vy = Math.round((a[1] + (b[1] - a[1]) * t - s.origin[1]) / SMOKE_VOXEL);
      const vz = Math.round((a[2] + (b[2] - a[2]) * t - s.origin[2]) / SMOKE_VOXEL);
      if (s.set.has(((vx + 128) << 16) | ((vy + 128) << 8) | (vz + 128))) { if (++inside >= 3) return true; }
    }
  }
  return false;
}

function smokeContains(s, p) {
  const vx = Math.round((p[0] - s.origin[0]) / SMOKE_VOXEL);
  const vy = Math.round((p[1] - s.origin[1]) / SMOKE_VOXEL);
  const vz = Math.round((p[2] + 8 - s.origin[2]) / SMOKE_VOXEL);
  return s.set.has(((vx + 128) << 16) | ((vy + 128) << 8) | (vz + 128));
}

// ---- fire: spreads over walkable ground -------------------------------------------
export function fireCells(world, landing) {
  const cells = [[landing[0], landing[1], landing[2], 0]];
  const key = (x, y) => `${x},${y}`;
  const seen = new Set([key(0, 0)]);
  let frontier = [[0, 0, landing[2]]];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let step = 1; step <= FIRE_MAX_STEPS && frontier.length && cells.length < FIRE_MAX_CELLS; step++) {
    const next = [];
    for (const [gx, gy, z] of frontier) {
      for (const [dx, dy] of DIRS) {
        const nx = gx + dx, ny = gy + dy;
        if (Math.hypot(nx, ny) > FIRE_MAX_STEPS) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.add(k);
        const x = landing[0] + nx * FIRE_CELL, y = landing[1] + ny * FIRE_CELL;
        // find the floor under this cell (fire flows down steps, not up walls)
        world.traceRay([x, y, z + 24], [x, y, z - 64], tr);
        if (!tr.hit || tr.normal[2] < 0.7) continue;
        const fz = tr.endpos[2];
        if (!clearLine(world, [landing[0] + gx * FIRE_CELL, landing[1] + gy * FIRE_CELL, z + 8], [x, y, fz + 8])) continue;
        cells.push([x, y, fz, step]);
        next.push([nx, ny, fz]);
        if (cells.length >= FIRE_MAX_CELLS) break;
      }
      if (cells.length >= FIRE_MAX_CELLS) break;
    }
    frontier = next;
  }
  return cells;
}

// ---- the grenade system (plugs into Match) ---------------------------------------------
export class GrenadeSystem {
  constructor() {
    this.nextId = 1;
    this.projectiles = []; // flying grenades
    this.smokes = []; // active smoke clouds
    this.fires = []; // active fires
    this.decoys = [];
  }

  attach(match) { this.m = match; }

  /** Called by Match when a player releases a grenade. */
  onThrow(p, t) {
    const m = this.m;
    const { vel, forward } = throwVelocity(t.pitch, t.yaw, t.strength, t.vel);
    // start a bit in front of the eyes, without starting inside a wall
    const want = [t.origin[0] + forward[0] * 16, t.origin[1] + forward[1] * 16, t.origin[2] + forward[2] * 16 - 4];
    m.world.traceBox(t.origin, want, NADE_HULL.mins, NADE_HULL.maxs, tr);
    const proj = {
      id: this.nextId++, kind: t.weapon, owner: p.id, team: p.team,
      pos: tr.endpos.slice(), vel, born: m.tick, resting: false, restTick: 0, bounces: 0,
    };
    this.projectiles.push(proj);
    m.emit({ type: 'throw', id: p.id, kind: t.weapon, nade: proj.id, pos: proj.pos.map(r1), vel: proj.vel.map(r1), strength: t.strength });
  }

  update() {
    const m = this.m;
    const age = (pr) => (m.tick - pr.born) * TICK_DT;
    for (const pr of this.projectiles) {
      const boxes = m.playerBoxes(null);
      const hit = stepProjectile(m.world, pr, TICK_DT, ELASTICITY, boxes);
      if (hit) m.emit({ type: 'bounce', nade: pr.id, pos: pr.pos.map(r1), except: -1 });
      if (pr.resting && !pr.restTick) pr.restTick = m.tick;
      const def = WEAPONS[pr.kind];
      let boom = false;
      if (pr.kind === 'he' || pr.kind === 'flash') boom = age(pr) >= def.nade.fuse;
      else if (pr.kind === 'molotov' || pr.kind === 'incendiary') boom = hit === 'ground' || age(pr) >= def.nade.fuse;
      else if (pr.kind === 'smoke' || pr.kind === 'decoy') boom = pr.resting && m.tick - pr.restTick >= TICK_RATE * 0.2;
      if (age(pr) > 20) boom = true; // never let one fly forever
      if (boom) { pr.done = true; this.detonate(pr, hit === 'ground'); }
    }
    this.projectiles = this.projectiles.filter((pr) => !pr.done);
    this.updateFires();
    this.updateDecoys();
    this.smokes = this.smokes.filter((s) => m.tick < s.until);
  }

  detonate(pr, onGround) {
    const m = this.m;
    switch (pr.kind) {
      case 'he': this.explodeHE(pr); break;
      case 'flash': this.explodeFlash(pr); break;
      case 'smoke': this.popSmoke(pr); break;
      case 'molotov':
      case 'incendiary': this.burst(pr, onGround); break;
      case 'decoy': this.startDecoy(pr); break;
      default: break;
    }
    void m;
  }

  explodeHE(pr) {
    const m = this.m;
    const def = WEAPONS.he;
    const owner = m.players.get(pr.owner) || null;
    const c = [pr.pos[0], pr.pos[1], pr.pos[2] + 2];
    for (const v of m.players.values()) {
      if (!v.alive) continue;
      const center = [v.ps.pos[0], v.ps.pos[1], v.ps.pos[2] + 36];
      const dist = Math.hypot(center[0] - c[0], center[1] - c[1], center[2] - c[2]);
      if (dist > HE_RADIUS) continue;
      // needs line of sight to the feet, body or head
      const pts = [center, [v.ps.pos[0], v.ps.pos[1], v.ps.pos[2] + 8], [v.ps.pos[0], v.ps.pos[1], v.ps.pos[2] + 62]];
      if (!pts.some((pt) => clearLine(m.world, c, pt))) continue;
      // CS: gaussian falloff, radius = 3 sigma
      const f = dist / HE_RADIUS;
      const raw = def.nade.damage * Math.exp(-f * f * 4.5);
      const dmg = computeDamage(raw, HITGROUP.GENERIC, def.armorPen, v);
      if (dmg.health <= 0) continue;
      m.damagePlayer(v, dmg.health, dmg.armor, owner, 'he', { group: HITGROUP.GENERIC, from: c });
    }
    m.emit({ type: 'boom', kind: 'he', nade: pr.id, pos: c.map(r1) });
  }

  explodeFlash(pr) {
    const m = this.m;
    const c = [pr.pos[0], pr.pos[1], pr.pos[2] + 2];
    for (const v of m.players.values()) {
      if (v.dummy && !v.alive) continue;
      const eye = v.alive ? [v.ps.pos[0], v.ps.pos[1], v.ps.pos[2] + 64 - 18 * v.ps.duckAmount] : v.ps.pos;
      const dx = c[0] - eye[0], dy = c[1] - eye[1], dz = c[2] - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 2500 || !clearLine(m.world, eye, c) || lineThroughSmoke(this.smokes, eye, c)) continue;
      const { forward } = angleVectors(v.pitch, v.yaw);
      const dot = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / (dist || 1);
      const strength = Math.pow(Math.max(0, 1 - dist / 2500), 0.6);
      // TODO: tune against CS2 flash durations
      let total, hold, alpha = 1;
      if (dot >= 0.6) { total = 4.9; hold = 1.9; }
      else if (dot >= 0.3) { total = 3.4; hold = 1.2; }
      else if (dot >= -0.2) { total = 2.0; hold = 0.6; }
      else { total = 0.9; hold = 0.2; alpha = 0.55; }
      total *= strength; hold *= strength;
      if (total < 0.15) continue;
      v.flashedUntil = m.tick + Math.round(total * TICK_RATE);
      m.emit({ type: 'flashed', id: v.id, by: pr.owner, duration: +total.toFixed(2), hold: +hold.toFixed(2), alpha, to: v.id });
    }
    m.emit({ type: 'boom', kind: 'flash', nade: pr.id, pos: c.map(r1) });
  }

  popSmoke(pr) {
    const m = this.m;
    const { origin, voxels } = smokeVoxels(m.world, pr.pos);
    const set = new Set();
    for (let i = 0; i < voxels.length; i += 3) set.add(((voxels[i] + 128) << 16) | ((voxels[i + 1] + 128) << 8) | (voxels[i + 2] + 128));
    const s = { id: pr.id, origin, voxels, set, born: m.tick, until: m.tick + WEAPONS.smoke.nade.duration * TICK_RATE };
    this.smokes.push(s);
    // a smoke puts out any fire it covers
    for (const f of this.fires) {
      const before = f.cells.length;
      f.cells = f.cells.filter((cell) => !smokeContains(s, cell));
      if (f.cells.length !== before) m.emit({ type: 'extinguish', fire: f.id, cells: f.cells.map((c) => c.map(r1)) });
    }
    m.emit({ type: 'smoke', nade: pr.id, origin: origin.map(r1), voxels, duration: WEAPONS.smoke.nade.duration });
  }

  burst(pr, onGround) {
    const m = this.m;
    const pos = pr.pos.slice();
    if (!onGround) { m.emit({ type: 'boom', kind: 'airburst', nade: pr.id, pos: pos.map(r1) }); return; }
    // landing in a smoke = fizzles out
    for (const s of this.smokes) {
      if (smokeContains(s, pos)) { m.emit({ type: 'boom', kind: 'fizzle', nade: pr.id, pos: pos.map(r1) }); return; }
    }
    let cells = fireCells(m.world, pos);
    const f = { id: pr.id, owner: pr.owner, kind: pr.kind, cells, born: m.tick, until: m.tick + WEAPONS[pr.kind].nade.duration * TICK_RATE, dmgAcc: new Map() };
    // existing smokes stop fire spreading into them
    for (const s of this.smokes) f.cells = f.cells.filter((c) => !smokeContains(s, c));
    cells = f.cells;
    this.fires.push(f);
    m.emit({ type: 'fire', nade: pr.id, kind: pr.kind, cells: cells.map((c) => c.map(r1)), duration: WEAPONS[pr.kind].nade.duration });
  }

  updateFires() {
    const m = this.m;
    for (const f of this.fires) {
      const ageSteps = (m.tick - f.born) * TICK_DT / 0.06; // fire spreads one step every 60 ms
      const owner = m.players.get(f.owner) || null;
      for (const v of m.players.values()) {
        if (!v.alive) continue;
        let inFire = false;
        for (const c of f.cells) {
          if (c[3] > ageSteps) continue;
          if (Math.abs(v.ps.pos[0] - c[0]) < 30 && Math.abs(v.ps.pos[1] - c[1]) < 30 && v.ps.pos[2] - c[2] > -12 && v.ps.pos[2] - c[2] < 48) { inFire = true; break; }
        }
        if (!inFire) continue;
        const acc = (f.dmgAcc.get(v.id) || 0) + FIRE_DPS * TICK_DT;
        const whole = Math.floor(acc);
        f.dmgAcc.set(v.id, acc - whole);
        if (whole > 0) {
          const dmg = computeDamage(whole, HITGROUP.GENERIC, WEAPONS[f.kind].armorPen, v);
          m.damagePlayer(v, dmg.health, 0, owner, f.kind, { group: HITGROUP.GENERIC });
        }
      }
    }
    this.fires = this.fires.filter((f) => m.tick < f.until && f.cells.length);
  }

  startDecoy(pr) {
    const m = this.m;
    const owner = m.players.get(pr.owner);
    let weapon = 'usps';
    if (owner) {
      const w = owner.ws;
      const pri = w.pri ? WEAPONS[Object.keys(WEAPONS).find((k) => WEAPONS[k].index === w.pri)] : null;
      const sec = w.sec ? WEAPONS[Object.keys(WEAPONS).find((k) => WEAPONS[k].index === w.sec)] : null;
      weapon = (pri || sec || WEAPONS.usps).id;
    }
    this.decoys.push({ id: pr.id, pos: pr.pos.slice(), weapon, until: m.tick + WEAPONS.decoy.nade.duration * TICK_RATE, next: m.tick, rng: makeRng(hashSeed(pr.id, m.tick)) });
    m.emit({ type: 'decoy', nade: pr.id, pos: pr.pos.map(r1) });
  }

  updateDecoys() {
    const m = this.m;
    for (const d of this.decoys) {
      if (m.tick >= d.next) {
        const burst = 1 + Math.floor(d.rng() * 3);
        m.emit({ type: 'decoyShot', nade: d.id, weapon: d.weapon, pos: d.pos.map(r1), count: burst });
        d.next = m.tick + Math.round((0.4 + d.rng() * 1.4) * TICK_RATE);
      }
    }
    for (const d of this.decoys) if (m.tick >= d.until) m.emit({ type: 'boom', kind: 'decoy', nade: d.id, pos: d.pos.map(r1) });
    this.decoys = this.decoys.filter((d) => m.tick < d.until);
  }

  /** Positions of flying grenades for the snapshot. */
  writeWorld(w) {
    w.u8(Math.min(255, this.projectiles.length));
    for (const pr of this.projectiles.slice(0, 255)) {
      w.u16(pr.id).u8(WEAPONS[pr.kind].index).f32(pr.pos[0]).f32(pr.pos[1]).f32(pr.pos[2]);
    }
  }

  /** For players who join mid-round: what's currently burning/smoking. */
  publicState() {
    const m = this.m;
    return {
      smokes: this.smokes.map((s) => ({ nade: s.id, origin: s.origin.map(r1), voxels: s.voxels, left: (s.until - m.tick) * TICK_DT })),
      fires: this.fires.map((f) => ({ nade: f.id, kind: f.kind, cells: f.cells.map((c) => c.map(r1)), left: (f.until - m.tick) * TICK_DT })),
    };
  }

  clear() {
    this.projectiles = []; this.smokes = []; this.fires = []; this.decoys = [];
  }
}

function r1(v) { return Math.round(v * 10) / 10; }
