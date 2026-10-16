// Weapon tests: fire rates, recoil, reloads, CS2 damage numbers, armor,
// wallbangs, knife backstabs, and prediction while shooting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, TEAM } from '../public/shared/match.js';
import { createWeaponState, processWeapon, giveWeapon, SLOT, switchTo, activeAmmo } from '../public/shared/weaponLogic.js';
import { createPlayerState, playerMove } from '../public/shared/movement.js';
import { computeDamage, traceBullet } from '../public/shared/bullets.js';
import { WEAPONS, HITGROUP, WEAPON_LIST } from '../public/shared/weapons.js';
import { IN } from '../public/shared/usercmd.js';
import { makeWorld, floor, boxTris, cmd } from './helpers.js';

function shooter(id = 'ak47') {
  const world = makeWorld(floor());
  const ps = createPlayerState();
  ps.pos = [0, 0, 0.05];
  for (let i = 0; i < 4; i++) playerMove(ps, cmd(0), { world });
  const ws = createWeaponState();
  giveWeapon(ws, 'knife_t');
  giveWeapon(ws, id);
  ws.active = WEAPONS[id].slot === 'secondary' ? SLOT.SECONDARY : SLOT.PRIMARY;
  return { world, ps, ws };
}

function fireFor(s, ticks, buttonsFn) {
  let shots = 0, old = s.ps.oldButtons;
  const all = [];
  for (let i = 0; i < ticks; i++) {
    const c = cmd(buttonsFn(i));
    const oldButtons = s.ps.oldButtons;
    playerMove(s.ps, c, { world: s.world });
    const out = processWeapon(s.ps, s.ws, c, { oldButtons, playerId: 1 });
    shots += out.shots.length;
    all.push(...out.shots);
    old = c.buttons;
  }
  void old;
  return { shots, all };
}

test('every CS2 weapon is defined with sane stats', () => {
  const guns = ['glock', 'usps', 'p2000', 'p250', 'fiveseven', 'tec9', 'cz75a', 'elite', 'deagle', 'r8',
    'mac10', 'mp9', 'mp7', 'mp5sd', 'ump45', 'p90', 'bizon', 'nova', 'xm1014', 'sawedoff', 'mag7', 'm249', 'negev',
    'famas', 'galil', 'm4a4', 'm4a1s', 'ak47', 'aug', 'sg553', 'ssg08', 'awp', 'scar20', 'g3sg1', 'zeus'];
  for (const id of [...guns, 'knife_t', 'knife_ct', 'he', 'flash', 'smoke', 'molotov', 'incendiary', 'decoy', 'c4']) {
    assert.ok(WEAPONS[id], `missing ${id}`);
  }
  for (const id of guns) {
    const w = WEAPONS[id];
    assert.ok(w.damage > 0 && w.rpm > 0 && w.clip > 0 && w.speed > 0, id);
    assert.ok(w.recoil.length >= 1, id);
  }
  assert.ok(WEAPON_LIST.length < 256);
});

test('AK-47 fires exactly 600 rounds/min while held', () => {
  const s = shooter('ak47');
  s.ws.time = 0; s.ws.deployEnd = 0;
  const { shots } = fireFor(s, 64 * 2, () => IN.ATTACK); // 2 s, but only 30 in the mag
  assert.equal(shots, 20 + 0 /* 2 s at 10/s = 20 */);
});

test('USP-S is semi-automatic: holding fires once', () => {
  const s = shooter('usps');
  const held = fireFor(s, 64, () => IN.ATTACK);
  assert.equal(held.shots, 1);
  const s2 = shooter('usps');
  const tapped = fireFor(s2, 64, (i) => (i % 12 < 2 ? IN.ATTACK : 0)); // tap every ~190 ms
  assert.ok(tapped.shots >= 5, `taps: ${tapped.shots}`);
});

test('recoil pattern is fixed and learnable (same every spray)', () => {
  const a = shooter('ak47'), b = shooter('ak47');
  fireFor(a, 40, () => IN.ATTACK);
  fireFor(b, 40, () => IN.ATTACK);
  assert.equal(a.ws.punchP, b.ws.punchP);
  assert.equal(a.ws.punchY, b.ws.punchY);
  assert.ok(a.ws.punchP < -2, `AK should climb, punch ${a.ws.punchP}`);
  // after letting go, the recoil resets
  fireFor(a, 64, () => 0);
  assert.equal(a.ws.recoilIndex, 0);
  assert.ok(Math.abs(a.ws.punchP) < 0.01);
});

test('first shot standing still is accurate; running shots are not', () => {
  const s = shooter('ak47');
  const still = fireFor(s, 1, () => IN.ATTACK).all[0];
  const d = still.dirs[0];
  assert.ok(Math.acos(d[0]) < 0.006, `still spread ${Math.acos(d[0])}`);
  // run at full speed then shoot
  const r = shooter('ak47');
  fireFor(r, 64, () => IN.MOVERIGHT);
  let maxDev = 0;
  for (let k = 0; k < 10; k++) {
    const rr = shooter('ak47');
    fireFor(rr, 64, () => IN.MOVERIGHT);
    rr.ws.shotSeq = k; // vary the seed
    const shot = fireFor(rr, 1, () => IN.MOVERIGHT | IN.ATTACK).all[0];
    maxDev = Math.max(maxDev, Math.acos(Math.min(1, shot.dirs[0][0])));
  }
  assert.ok(maxDev > 0.03, `running spread ${maxDev}`);
});

test('reload refills the magazine from reserve', () => {
  const s = shooter('ak47');
  fireFor(s, 64 * 4, () => IN.ATTACK); // empties the mag, then auto-reloads
  fireFor(s, 64 * 3, () => 0);
  const a = activeAmmo(s.ws);
  assert.equal(a.clip, 30);
  assert.equal(a.reserve, 60);
});

test('switching weapons takes the deploy time before you can shoot', () => {
  const s = shooter('ak47');
  switchTo(s.ws, SLOT.KNIFE);
  const r = fireFor(s, 2, () => 0);
  void r;
  s.ws.active = SLOT.KNIFE;
  // switch back to the rifle and try to shoot immediately
  const c = cmd(0); c.select = 1;
  processWeapon(s.ps, s.ws, c, { oldButtons: 0, playerId: 1 });
  const early = fireFor(s, 32, () => IN.ATTACK); // 0.5 s < 1.0 s deploy
  assert.equal(early.shots, 0);
  const later = fireFor(s, 64, () => IN.ATTACK);
  assert.ok(later.shots > 0);
});

test('CS2 damage numbers with armor and helmet', () => {
  const armored = { armor: 100, helmet: true };
  const noHelmet = { armor: 100, helmet: false };
  const naked = { armor: 0, helmet: false };
  const d = (id, group, victim) => computeDamage(WEAPONS[id].damage, group, WEAPONS[id].armorPen, victim).health;
  assert.equal(d('ak47', HITGROUP.HEAD, armored), 111); // AK one-taps helmets
  assert.equal(d('ak47', HITGROUP.CHEST, armored), 27);
  assert.equal(d('ak47', HITGROUP.CHEST, naked), 36);
  assert.equal(d('ak47', HITGROUP.LEFTLEG, armored), 27);
  assert.equal(d('m4a4', HITGROUP.HEAD, armored), 92); // M4A4 doesn't one-tap helmets
  assert.equal(d('m4a4', HITGROUP.HEAD, noHelmet), 132);
  assert.equal(d('usps', HITGROUP.HEAD, armored), 70);
  assert.equal(d('awp', HITGROUP.CHEST, armored), 112);
  assert.equal(d('deagle', HITGROUP.HEAD, armored), 197);
  assert.equal(d('ak47', HITGROUP.STOMACH, naked), 45);
});

test('wallbangs: thin walls reduce damage, thick walls stop bullets', () => {
  const testAt = (thickness) => {
    const world = makeWorld(floor(), boxTris([200, -500, 0], [200 + thickness, 500, 200]));
    const target = (start, dir, maxDist) => {
      // a target plane at x=400
      if (dir[0] <= 0) return null;
      const t = (400 - start[0]) / dir[0];
      return t <= maxDist ? { t, id: 2, group: HITGROUP.CHEST } : null;
    };
    const r = traceBullet(world, [0, 0, 64], [1, 0, 0], WEAPONS.ak47, target, 1);
    return r.hits.length ? r.hits[0].damage : 0;
  };
  const thin = testAt(8), thick = testAt(40);
  assert.ok(thin > 10 && thin < 30, `thin wall damage ${thin}`);
  assert.equal(thick, 0);
});

function duel(attackerWeapon) {
  const world = makeWorld(floor());
  const m = new Match({ world, map: { spawns: { T: [[0, 0, 1, 0]], CT: [[300, 0, 1, 180]] }, devSpawn: [0, 0, 1, 0] }, mode: 'sandbox' });
  const a = m.addPlayer({ name: 'A', team: TEAM.T, token: 'aaaaaaaaaa' });
  const b = m.addPlayer({ name: 'B', team: TEAM.CT, token: 'bbbbbbbbbb' });
  a.ps.pos = [0, 0, 0.05]; b.ps.pos = [300, 0, 0.05];
  giveWeapon(a.ws, attackerWeapon);
  a.ws.active = WEAPONS[attackerWeapon].slot === 'knife' ? SLOT.KNIFE : SLOT.PRIMARY;
  a.ws.deployEnd = 0;
  for (let i = 0; i < 70; i++) m.step();
  return { m, a, b };
}

test('server: shooting a player in the head with an AK kills them', () => {
  const { m, a, b } = duel('ak47');
  b.yaw = 180;
  // aim at B's head from A's eyes
  const eye = [a.ps.pos[0], a.ps.pos[1], a.ps.pos[2] + 64];
  const head = [b.ps.pos[0] + 1.5, b.ps.pos[1], b.ps.pos[2] + 65];
  const yaw = Math.atan2(head[1] - eye[1], head[0] - eye[0]) * 180 / Math.PI;
  const pitch = -Math.atan2(head[2] - eye[2], Math.hypot(head[0] - eye[0], head[1] - eye[1])) * 180 / Math.PI;
  let num = 1000;
  const c = cmd(IN.ATTACK, yaw, pitch); c.num = num++; c.interp = m.tick;
  m.runCommand(a, c);
  assert.equal(b.alive, false);
  const kill = m.events.find((e) => e.type === 'kill');
  assert.ok(kill && kill.headshot);
});

test('server: knife backstab does 180 with right click, front stab 65', () => {
  for (const [bYaw, expect] of [[0, 'backstab'], [180, 'front']]) {
    const { m, a, b } = duel('knife_t');
    b.ps.pos = [40, 0, 0.05];
    b.yaw = bYaw; // 0 = facing away from A (A is at x=0 looking +x)
    b.armor = 0;
    for (let i = 0; i < 3; i++) m.step();
    const c = cmd(IN.ATTACK2, 0, 10); c.num = 5000; c.interp = m.tick;
    m.runCommand(a, c);
    if (expect === 'backstab') assert.equal(b.alive, false, 'backstab should kill');
    else assert.equal(b.health, 35, `front stab hp ${b.health}`);
  }
});
