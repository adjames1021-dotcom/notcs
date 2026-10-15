// Grenades, dropped weapons and the special weapon mechanics of stage 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, TEAM } from '../public/shared/match.js';
import { throwVelocity, smokeVoxels, SMOKE_VOXEL } from '../public/shared/grenades.js';
import { createWeaponState, processWeapon, giveWeapon, SLOT, activeAmmo, FLAG } from '../public/shared/weaponLogic.js';
import { createPlayerState, playerMove } from '../public/shared/movement.js';
import { IN, IMPULSE } from '../public/shared/usercmd.js';
import { WEAPONS } from '../public/shared/weapons.js';
import { makeWorld, floor, boxTris, cmd } from './helpers.js';

const MAP = { spawns: { T: [[0, 0, 1, 0]], CT: [[400, 0, 1, 180]] }, devSpawn: [0, 0, 1, 0] };

function arena(...extra) {
  const world = makeWorld(floor(), ...extra);
  const m = new Match({ world, map: MAP, mode: 'sandbox' });
  const a = m.addPlayer({ name: 'A', team: TEAM.T, token: 'aaaaaaaaaa' });
  const b = m.addPlayer({ name: 'B', team: TEAM.CT, token: 'bbbbbbbbbb' });
  for (let i = 0; i < 10; i++) m.step();
  return { m, a, b };
}

function place(p, x, y, yaw = 0) {
  p.ps.pos = [x, y, 0.05];
  p.ps.vel = [0, 0, 0];
  p.yaw = yaw;
}

function run(m, seconds) { for (let i = 0; i < seconds * 64; i++) m.step(); }

test('throw strength: left 750, both 487.5, right 225 (plus your velocity)', () => {
  const sp = (s) => { const v = throwVelocity(0, 0, s, [0, 0, 0]).vel; return Math.hypot(...v); };
  assert.ok(Math.abs(sp(1) - 750) < 1e-6);
  assert.ok(Math.abs(sp(0.5) - 487.5) < 1e-6);
  assert.ok(Math.abs(sp(0) - 225) < 1e-6);
  const running = throwVelocity(0, 0, 1, [250, 0, 0]).vel;
  assert.ok(running[0] > 750 * Math.cos(10 * Math.PI / 180) + 300);
});

test('HE: full damage close, falls off with distance, blocked by walls', () => {
  const { m, a, b } = arena();
  place(a, 0, 0); place(b, 100, 0);
  m.grenades.projectiles.push({ id: 99, kind: 'he', owner: a.id, team: a.team, pos: [100, 0, 30], vel: [0, 0, 0], born: m.tick - 64 * 2, resting: true, restTick: m.tick });
  m.step();
  assert.ok(b.health < 15, `close HE left ${b.health} hp`);

  const r2 = arena(boxTris([150, -300, 0], [170, 300, 300]));
  place(r2.a, 0, 0); place(r2.b, 200, 0);
  r2.m.grenades.projectiles.push({ id: 98, kind: 'he', owner: r2.a.id, pos: [120, 0, 30], vel: [0, 0, 0], born: r2.m.tick - 200, resting: true, restTick: r2.m.tick });
  r2.m.step();
  assert.equal(r2.b.health, 100, 'wall should block the HE');
});

test('flashbang: facing it blinds for long, facing away for short, walls block it', () => {
  const durations = {};
  for (const [name, yaw, wall] of [['facing', 0, false], ['away', 180, false], ['wall', 0, true]]) {
    const { m, a, b } = arena(...(wall ? [boxTris([150, -300, 0], [170, 300, 300])] : []));
    place(a, -500, 0); place(b, 0, 0, yaw); b.pitch = 0;
    m.events.length = 0;
    m.grenades.projectiles.push({ id: 7, kind: 'flash', owner: a.id, pos: [300, 0, 60], vel: [0, 0, 0], born: m.tick - 200, resting: true, restTick: m.tick });
    m.step();
    const ev = m.events.find((e) => e.type === 'flashed' && e.id === b.id);
    durations[name] = ev ? ev.duration : 0;
  }
  assert.ok(durations.facing > 3, `facing ${durations.facing}`);
  assert.ok(durations.away > 0 && durations.away < 1, `away ${durations.away}`);
  assert.equal(durations.wall, 0);
});

test('smoke: fills open space but does not leak through walls', () => {
  const world = makeWorld(floor(), boxTris([60, -400, 0], [76, 400, 300]));
  const { origin, voxels } = smokeVoxels(world, [0, 0, 1]);
  const n = voxels.length / 3;
  assert.ok(n > 300, `voxels ${n}`);
  for (let i = 0; i < voxels.length; i += 3) {
    const x = origin[0] + voxels[i] * SMOKE_VOXEL;
    assert.ok(x < 76, `voxel leaked through wall at x=${x}`);
  }
});

test('molotov: fire spreads on the ground, hurts, and smoke puts it out', () => {
  const { m, a, b } = arena();
  place(a, -400, 0); place(b, 0, 0);
  m.grenades.projectiles.push({ id: 11, kind: 'molotov', owner: a.id, pos: [10, 0, 40], vel: [0, 0, -300], born: m.tick, resting: false });
  run(m, 1.5);
  assert.ok(m.grenades.fires.length === 1, 'fire started');
  assert.ok(b.health < 100, `standing in fire hp ${b.health}`);
  // a smoke on top puts it out
  m.grenades.projectiles.push({ id: 12, kind: 'smoke', owner: a.id, pos: [0, 0, 2], vel: [0, 0, 0], born: m.tick, resting: true, restTick: m.tick - 64 });
  run(m, 0.5);
  assert.equal(m.grenades.fires.length, 0, 'fire extinguished');
});

test('grenades bounce off walls and come to rest', () => {
  const { m, a } = arena(boxTris([200, -300, 0], [220, 300, 300]));
  place(a, 0, 0);
  const v = throwVelocity(0, 0, 1, [0, 0, 0]);
  const pr = { id: 5, kind: 'smoke', owner: a.id, pos: [0, 0, 64], vel: v.vel, born: m.tick, resting: false };
  m.grenades.projectiles.push(pr);
  run(m, 0.6);
  assert.ok(pr.pos[0] < 200, `went through the wall: x=${pr.pos[0]}`);
  run(m, 4);
  assert.ok(pr.resting || pr.done, 'came to rest');
});

test('dying drops your gun; walking over it picks it up', () => {
  const { m, a, b } = arena();
  place(a, 0, 0); place(b, 300, 0);
  giveWeapon(b.ws, 'awp');
  m.killPlayer(b, a, 'ak47');
  assert.ok(m.items.items.some((it) => it.weapon === 'awp'));
  run(m, 1.5);
  const awp = m.items.items.find((it) => it.weapon === 'awp');
  place(a, awp.pos[0], awp.pos[1]);
  run(m, 0.2);
  assert.equal(a.ws.pri, WEAPONS.awp.index, 'picked up the AWP');
});

// --- special weapon mechanics -------------------------------------------------
function holder(id) {
  const world = makeWorld(floor());
  const ps = createPlayerState();
  ps.pos = [0, 0, 0.05];
  for (let i = 0; i < 4; i++) playerMove(ps, cmd(0), { world });
  const ws = createWeaponState();
  giveWeapon(ws, id);
  ws.active = WEAPONS[id].slot === 'secondary' ? SLOT.SECONDARY : WEAPONS[id].slot === 'zeus' ? SLOT.ZEUS : SLOT.PRIMARY;
  return { world, ps, ws };
}
function tick(h, buttons, extra = {}) {
  const c = cmd(buttons); Object.assign(c, extra);
  const oldButtons = h.ps.oldButtons;
  playerMove(h.ps, c, { world: h.world });
  return processWeapon(h.ps, h.ws, c, { oldButtons, playerId: 1 });
}

test('shotguns fire all their pellets', () => {
  const h = holder('nova');
  const out = tick(h, IN.ATTACK);
  assert.equal(out.shots[0].dirs.length, 9);
});

test('Glock burst mode fires 3 rounds per click', () => {
  const h = holder('glock');
  tick(h, IN.ATTACK2); // switch to burst
  tick(h, 0);
  let shots = 0;
  for (let i = 0; i < 20; i++) shots += tick(h, i === 0 ? IN.ATTACK : 0).shots.length;
  assert.equal(shots, 3);
});

test('AWP scopes in, unscopes after a shot, rezooms after the bolt', () => {
  const h = holder('awp');
  tick(h, IN.ATTACK2);
  assert.equal(h.ws.zoom, 1);
  tick(h, 0);
  tick(h, IN.ATTACK);
  assert.equal(h.ws.zoom, 0);
  for (let i = 0; i < 64 * 1.6; i++) tick(h, 0);
  assert.equal(h.ws.zoom, 1);
});

test('silencer takes time to attach/remove', () => {
  const h = holder('m4a1s');
  assert.ok(activeAmmo(h.ws).flags & FLAG.SILENCER_ON);
  tick(h, IN.ATTACK2);
  for (let i = 0; i < 64 * 2.2; i++) tick(h, 0);
  assert.equal(activeAmmo(h.ws).flags & FLAG.SILENCER_ON, 0);
});

test('R8 needs to cock before firing', () => {
  const h = holder('r8');
  let firstShotTick = -1;
  for (let i = 0; i < 64; i++) if (tick(h, IN.ATTACK).shots.length && firstShotTick < 0) firstShotTick = i;
  assert.ok(firstShotTick >= 25 && firstShotTick <= 27, `R8 fired at tick ${firstShotTick}`);
});

test('Zeus recharges after 30 seconds', () => {
  const h = holder('zeus');
  assert.equal(tick(h, IN.ATTACK).shots.length, 1);
  let shots = 0;
  for (let i = 0; i < 64 * 29; i++) shots += tick(h, i % 2 ? IN.ATTACK : 0).shots.length;
  assert.equal(shots, 0);
  for (let i = 0; i < 64 * 2; i++) shots += tick(h, i % 2 ? IN.ATTACK : 0).shots.length;
  assert.equal(shots, 1);
});

test('grenade throw: hold, release, grenade removed, switches back', () => {
  const h = holder('ak47');
  giveWeapon(h.ws, 'he');
  tick(h, 0, { select: 4 });
  assert.equal(h.ws.active, SLOT.HE);
  for (let i = 0; i < 64; i++) tick(h, 0);
  tick(h, IN.ATTACK);
  for (let i = 0; i < 10; i++) tick(h, IN.ATTACK);
  const out = tick(h, 0);
  assert.ok(out.throw && out.throw.weapon === 'he' && out.throw.strength === 1);
  assert.equal(h.ws.he, 0);
  assert.equal(h.ws.active, SLOT.PRIMARY);
  void IMPULSE;
});
