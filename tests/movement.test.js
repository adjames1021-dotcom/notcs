// Movement tests: these check the numbers that make movement "feel like CS".
// Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerState, playerMove, eyeHeight } from '../public/shared/movement.js';
import { IN } from '../public/shared/usercmd.js';
import { TICK_DT, HULL_STAND } from '../public/shared/constants.js';
import { makeWorld, floor, boxTris, rampTris, cmd, speed2d, loadRealMap } from './helpers.js';

function spawnOn(world, x = 0, y = 0, z = 0.05) {
  const ps = createPlayerState();
  ps.pos = [x, y, z];
  // settle onto the ground
  for (let i = 0; i < 4; i++) playerMove(ps, cmd(0), { world });
  return ps;
}

function run(ps, world, ticks, buttons, yaw = 0, extra = {}) {
  let last;
  for (let i = 0; i < ticks; i++) last = playerMove(ps, cmd(buttons, typeof yaw === 'function' ? yaw(i) : yaw), { world, ...extra });
  return last;
}

test('player lands on the floor and stays DIST_EPSILON above it', () => {
  const world = makeWorld(floor());
  const ps = createPlayerState();
  ps.pos = [0, 0, 100];
  run(ps, world, 64, 0);
  assert.equal(ps.onGround, true);
  assert.ok(ps.pos[2] > 0 && ps.pos[2] < 0.1, `z=${ps.pos[2]}`);
});

test('running accelerates to exactly 250 (knife) and no faster', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  let ticksTo245 = -1;
  for (let i = 0; i < 128; i++) {
    playerMove(ps, cmd(IN.FORWARD, 0), { world });
    if (ticksTo245 < 0 && speed2d(ps) >= 245) ticksTo245 = i + 1;
  }
  assert.ok(Math.abs(speed2d(ps) - 250) < 0.01, `speed ${speed2d(ps)}`);
  // CS reaches full speed in roughly 0.3-0.5 s
  assert.ok(ticksTo245 > 10 && ticksTo245 < 40, `ticks to 245: ${ticksTo245}`);
});

test('weapon max speed is respected (AK-47 = 215)', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 128, IN.FORWARD, 0, { maxSpeed: 215 });
  assert.ok(Math.abs(speed2d(ps) - 215) < 0.01);
});

test('diagonal running is not faster than straight running', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 128, IN.FORWARD | IN.MOVERIGHT, 0);
  assert.ok(speed2d(ps) <= 250.01, `speed ${speed2d(ps)}`);
});

test('friction stops you in well under half a second', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 128, IN.FORWARD);
  let ticks = 0;
  while (speed2d(ps) > 0 && ticks < 200) { playerMove(ps, cmd(0), { world }); ticks++; }
  assert.ok(ticks > 5 && ticks < 32, `stop ticks ${ticks}`);
});

test('counter-strafing makes you accurate (<34% speed) in ~100ms', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 128, IN.MOVERIGHT);
  let ticks = 0;
  while (speed2d(ps) > 250 * 0.34 && ticks < 64) { playerMove(ps, cmd(IN.MOVELEFT), { world }); ticks++; }
  assert.ok(ticks <= 8, `counter-strafe ticks ${ticks}`);
  // ...and it's faster than just letting go
  const ps2 = spawnOn(world);
  run(ps2, world, 128, IN.MOVERIGHT);
  let ticks2 = 0;
  while (speed2d(ps2) > 250 * 0.34 && ticks2 < 64) { playerMove(ps2, cmd(0), { world }); ticks2++; }
  assert.ok(ticks < ticks2, `counter ${ticks} vs release ${ticks2}`);
});

test('walking (shift) caps at 52% and crouching at 34%', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 128, IN.FORWARD | IN.WALK);
  assert.ok(Math.abs(speed2d(ps) - 130) < 0.01, `walk ${speed2d(ps)}`);
  const ps2 = spawnOn(world);
  run(ps2, world, 128, IN.FORWARD | IN.DUCK);
  assert.ok(Math.abs(speed2d(ps2) - 85) < 0.01, `duck ${speed2d(ps2)}`);
  assert.equal(ps2.ducked, true);
  assert.equal(eyeHeight(ps2), 46);
});

test('walking is silent, running makes footsteps', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  let steps = 0;
  for (let i = 0; i < 192; i++) if (playerMove(ps, cmd(IN.FORWARD | IN.WALK), { world }).footstep) steps++;
  assert.equal(steps, 0);
  for (let i = 0; i < 192; i++) if (playerMove(ps, cmd(IN.FORWARD), { world }).footstep) steps++;
  assert.ok(steps >= 6, `steps ${steps}`);
});

test('jump matches CS2: 286.37 u/s after the jump tick, apex 55.82, ~0.73 s in the air', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  const z0 = ps.pos[2];
  playerMove(ps, cmd(IN.JUMP), { world });
  assert.ok(Math.abs(ps.vel[2] - 286.368) < 0.01, `end-of-tick velocity ${ps.vel[2]}`);
  let maxZ = ps.pos[2], ticks = 1;
  while (!ps.onGround && ticks < 200) {
    const v = ps.vel[2];
    playerMove(ps, cmd(0), { world });
    if (!ps.onGround) assert.ok(Math.abs(v - ps.vel[2] - 12.5) < 1e-9, 'gravity takes 12.5 u/s per tick');
    maxZ = Math.max(maxZ, ps.pos[2]);
    ticks++;
  }
  const h = maxZ - z0;
  assert.ok(h > 55.6 && h < 55.9, `jump height ${h}`);
  assert.ok(ticks >= 46 && ticks <= 48, `air ticks ${ticks}`);
});

test('crouching takes exactly 10 ticks (CS2)', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  let ticks = 0;
  while (!ps.ducked && ticks < 50) { playerMove(ps, cmd(IN.DUCK), { world }); ticks++; }
  assert.equal(ticks, 10);
});

test('holding jump does not auto-bunnyhop', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  let jumps = 0;
  for (let i = 0; i < 256; i++) if (playerMove(ps, cmd(IN.JUMP), { world }).jumped) jumps++;
  assert.equal(jumps, 1);
});

test('you can step up 18 units but not 24', () => {
  for (const [h, expectOnTop] of [[18, true], [24, false]]) {
    const world = makeWorld(floor(), boxTris([64, -200, 0], [400, 200, h]));
    const ps = spawnOn(world);
    run(ps, world, 64, IN.FORWARD, 0);
    const onTop = ps.pos[2] > h - 0.5;
    assert.equal(onTop, expectOnTop, `step ${h}: z=${ps.pos[2]} x=${ps.pos[0]}`);
  }
});

test('stairs (16 unit steps) can be walked up at full speed', () => {
  const parts = [floor()];
  for (let i = 0; i < 8; i++) parts.push(boxTris([64 + i * 16, -200, 0], [1000, 200, (i + 1) * 16]));
  const world = makeWorld(...parts);
  const ps = spawnOn(world);
  run(ps, world, 96, IN.FORWARD, 0);
  assert.ok(ps.pos[2] > 127, `z=${ps.pos[2]}`);
  assert.ok(speed2d(ps) > 240, `speed ${speed2d(ps)}`);
});

test('walking up a 30° slope works, a 50° slope does not', () => {
  for (const [deg, expectUp] of [[30, true], [50, false]]) {
    const rise = Math.tan(deg * Math.PI / 180) * 600;
    const world = makeWorld(floor(), rampTris(64, 664, -400, 400, 0, rise), boxTris([664, -400, 0], [900, 400, rise]));
    const ps = spawnOn(world);
    run(ps, world, 192, IN.FORWARD, 0);
    const up = ps.pos[2] > rise * 0.5;
    assert.equal(up, expectUp, `${deg}°: z=${ps.pos[2].toFixed(1)} rise=${rise.toFixed(0)}`);
  }
});

test('sliding along a wall keeps the parallel speed', () => {
  const world = makeWorld(floor(), boxTris([100, -2000, 0], [200, 2000, 200]));
  const ps = spawnOn(world);
  run(ps, world, 128, IN.FORWARD, 45); // run diagonally into the wall
  assert.ok(ps.pos[0] < 100 - 15.9, `x=${ps.pos[0]}`);
  assert.ok(ps.vel[1] > 150, `parallel speed ${ps.vel[1]}`);
});

test('crouch-jump reaches a 64 unit box, a normal jump does not', () => {
  for (const crouch of [false, true]) {
    const world = makeWorld(floor(), boxTris([40, -200, 0], [400, 200, 64]));
    // stand right in front of the box, jump while holding forward
    const ps = spawnOn(world, 40 - 16 - 2, 0);
    playerMove(ps, cmd(IN.FORWARD | IN.JUMP), { world });
    for (let i = 0; i < 80; i++) {
      const b = IN.FORWARD | (crouch && i > 6 ? IN.DUCK : 0);
      playerMove(ps, cmd(b), { world });
    }
    const onBox = ps.pos[2] >= 63.9 && ps.pos[0] > 40;
    assert.equal(onBox, crouch, `crouch=${crouch} z=${ps.pos[2]} x=${ps.pos[0]}`);
  }
});

test('ducking in the air lifts your feet 9 units (CS2)', () => {
  const world = makeWorld(floor());
  const a = spawnOn(world), b = spawnOn(world);
  for (const ps of [a, b]) { playerMove(ps, cmd(IN.JUMP), { world }); run(ps, world, 5, 0); }
  playerMove(a, cmd(0), { world });
  playerMove(b, cmd(IN.DUCK), { world });
  assert.equal(b.ducked, true);
  assert.ok(Math.abs(b.pos[2] - a.pos[2] - 9) < 1e-6, `feet ${b.pos[2] - a.pos[2]} higher`);
  const eyeA = a.pos[2] + eyeHeight(a), eyeB = b.pos[2] + eyeHeight(b);
  assert.ok(Math.abs(eyeA - eyeB - 9) < 1e-6, `eyes ${eyeA - eyeB} lower`);
});

test('cannot stand up under a low ceiling', () => {
  const world = makeWorld(floor(), boxTris([-100, -100, 60], [100, 100, 80]));
  const ps = spawnOn(world, 0, 0);
  // crouch in place (ceiling at 60 > 54 so the crouch hull fits) — start crouched
  ps.ducked = true; ps.duckAmount = 1;
  run(ps, world, 32, 0); // released crouch
  assert.equal(ps.ducked, true);
  // walk out from under it and you stand up
  run(ps, world, 96, IN.FORWARD);
  assert.equal(ps.ducked, false);
});

test('fall damage: ~200 units is safe, ~600 hurts a lot, ~800 kills', () => {
  const results = {};
  for (const h of [200, 300, 600, 800]) {
    const world = makeWorld(floor());
    const ps = createPlayerState();
    ps.pos = [0, 0, h];
    let dmg = 0;
    for (let i = 0; i < 200; i++) dmg += playerMove(ps, cmd(0), { world }).fallDamage;
    results[h] = dmg;
  }
  assert.equal(results[200], 0);
  assert.ok(results[300] > 0 && results[300] < 40, `300: ${results[300]}`);
  assert.ok(results[600] > 50 && results[600] < 100, `600: ${results[600]}`);
  assert.ok(results[800] >= 100, `800: ${results[800]}`);
});

test('air strafing gains speed, but jumping caps it at 1.1x max speed', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 64, IN.FORWARD, 0);
  playerMove(ps, cmd(IN.JUMP | IN.FORWARD, 0), { world });
  // classic strafe: hold right and turn right smoothly
  let yaw = 0;
  let maxAir = 0;
  for (let i = 0; i < 40 && !ps.onGround; i++) {
    yaw -= 2.2;
    playerMove(ps, cmd(IN.MOVERIGHT, yaw), { world });
    maxAir = Math.max(maxAir, speed2d(ps));
  }
  assert.ok(maxAir > 270, `air strafe max ${maxAir}`);
  // bhop on landing: speed is cropped to 275
  while (!ps.onGround) playerMove(ps, cmd(0, yaw), { world });
  playerMove(ps, cmd(IN.JUMP, yaw), { world });
  assert.ok(speed2d(ps) <= 275.01, `after bhop ${speed2d(ps)}`);
});

test('landing from a single jump does not slow you down (CS2)', () => {
  const world = makeWorld(floor());
  const ps = spawnOn(world);
  run(ps, world, 64, IN.FORWARD);
  playerMove(ps, cmd(IN.FORWARD | IN.JUMP), { world });
  while (!ps.onGround) playerMove(ps, cmd(IN.FORWARD), { world });
  let minSpeed = Infinity;
  for (let i = 0; i < 64; i++) { playerMove(ps, cmd(IN.FORWARD), { world }); minSpeed = Math.min(minSpeed, speed2d(ps)); }
  assert.ok(minSpeed > 249.9, `min speed after landing ${minSpeed}`);
});

test('jumping again right after landing gives a lower jump (stamina)', () => {
  const world = makeWorld(floor());
  const height = (ps) => {
    const z0 = ps.pos[2];
    let top = z0;
    playerMove(ps, cmd(IN.JUMP), { world });
    while (!ps.onGround) { playerMove(ps, cmd(0), { world }); top = Math.max(top, ps.pos[2]); }
    return top - z0;
  };
  const ps = spawnOn(world);
  const first = height(ps);
  const second = height(ps); // straight away, still tired from landing
  run(ps, world, 64, 0);
  const rested = height(ps);
  assert.ok(second < first - 3, `second jump ${second} vs ${first}`);
  assert.ok(Math.abs(rested - first) < 1e-6, `rested jump ${rested}`);
});

test('simulation is deterministic (prediction == server)', () => {
  const world = makeWorld(floor(), boxTris([300, -50, 0], [400, 50, 40]));
  const a = spawnOn(world), b = spawnOn(world);
  const seq = [];
  for (let i = 0; i < 300; i++) seq.push(cmd((i % 37 < 20 ? IN.FORWARD : IN.MOVELEFT) | (i % 50 === 0 ? IN.JUMP : 0), i * 1.7));
  for (const c of seq) playerMove(a, c, { world });
  for (const c of seq) playerMove(b, c, { world });
  assert.deepEqual(a, b);
});

test('real map: loads at the right scale with Z up', () => {
  const { geo } = loadRealMap();
  assert.ok(geo.size[0] > 3000 && geo.size[0] < 8000, `X size ${geo.size[0]}`);
  assert.ok(geo.size[1] > 3000 && geo.size[1] < 8000, `Y size ${geo.size[1]}`);
  assert.ok(geo.size[2] < 1500, `Z size ${geo.size[2]}`);
});

test('real map: every spawn point is valid and on the ground', async () => {
  const { world } = loadRealMap();
  const { MAP } = await import('../public/config/map.js');
  for (const team of ['T', 'CT']) {
    for (const s of MAP.spawns[team]) {
      const ps = createPlayerState();
      ps.pos = [s[0], s[1], s[2] + 2];
      assert.equal(world.testBox(ps.pos, HULL_STAND.mins, HULL_STAND.maxs), false, `${team} spawn ${s} is inside a wall`);
      for (let i = 0; i < 32; i++) playerMove(ps, cmd(0), { world });
      assert.equal(ps.onGround, true, `${team} spawn ${s} not on ground`);
      assert.ok(Math.abs(ps.pos[2] - s[2]) < 40, `${team} spawn ${s} fell to ${ps.pos[2]}`);
    }
  }
});

test('real map: run around T spawn without getting stuck on edges', () => {
  const { world } = loadRealMap();
  const ps = createPlayerState();
  ps.pos = [-1272, -800, 130];
  for (let i = 0; i < 16; i++) playerMove(ps, cmd(0), { world });
  // run in 8 directions for 1 s each, measure average speed (walls will stop
  // some, but most runs should be fast and none should leave us stuck)
  let stuckRuns = 0;
  for (let d = 0; d < 8; d++) {
    const start = ps.pos.slice();
    for (let i = 0; i < 64; i++) playerMove(ps, cmd(IN.FORWARD, d * 45), { world });
    const moved = Math.hypot(ps.pos[0] - start[0], ps.pos[1] - start[1]);
    if (moved < 20) stuckRuns++;
    assert.ok(Number.isFinite(ps.pos[2]) && ps.pos[2] > -500, 'fell out of the world');
  }
  assert.ok(stuckRuns <= 2, `stuck in ${stuckRuns} of 8 directions`);
});
