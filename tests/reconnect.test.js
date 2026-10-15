// Connection-drop tests: what happens when a player's connection drops and
// comes back, plus the deathmatch/idle/collision-file rules that go with
// running online cheaply and reliably.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchServer, CLOSE_IDLE } from '../public/shared/server.js';
import { Game } from '../public/js/game.js';
import { MAP } from '../public/config/map.js';
import { IN } from '../public/shared/usercmd.js';
import { TICK_RATE } from '../public/shared/constants.js';
import { CollisionWorld, createTrace } from '../public/shared/collision.js';
import { loadRealMap } from './helpers.js';

function makeClient(world, transport, input) {
  const stub = () => {};
  return new Game({
    renderer: { setView: stub, render: stub },
    input, transport, world, settings: {}, hud: null,
    audio: { footstep: stub, land: stub, hurt: stub, setListener: stub },
    mode: 'test', players: null,
  });
}

function makeInput() {
  return {
    buttons: 0, yaw: 90, pitch: 0, selectNext: 0, impulseNext: 0,
    sampleButtons() { return this.buttons; },
    takeSelect() { const v = this.selectNext; this.selectNext = 0; return v; },
    takeImpulse() { const v = this.impulseNext; this.impulseNext = 0; return v; },
  };
}

/** One client on an instant network. reconnect() makes a new socket, like after a drop. */
function harness(mode = 'deathmatch') {
  const { world } = loadRealMap();
  const server = new MatchServer({ world, map: MAP, mode });
  server.start = () => {};
  const input = makeInput();
  const up = [];
  const transport = { onmessage: null, onclose: null, send(d) { up.push(d); }, close() {} };
  const client = makeClient(world, transport, input);
  let session = null;
  const connect = (c, token) => {
    session = server.connect({ send: (d) => c.onMessage(d), close() {} });
    session.onMessage(JSON.stringify({ type: 'join', name: 'A', team: 'T', token }));
  };
  connect(client);
  const run = (ticks, c = client) => {
    for (let i = 0; i < ticks; i++) {
      c.tick();
      while (up.length) session.onMessage(up.shift());
      server.step();
    }
  };
  const me = () => [...server.match.players.values()].find((p) => p.name === 'A');
  return { world, server, client, input, transport, run, me, connect, drop: () => session.onClose(), up };
}

test('after a reconnect the server accepts our input again (same game keeps going)', () => {
  const h = harness();
  h.run(5 * TICK_RATE); // play for 5 s: ~320 commands
  const p = h.me();
  assert.ok(p.lastCmdNum > 300);
  h.drop();
  h.connect(h.client, h.client.joinInfo?.token ?? p.token);
  assert.equal(h.me(), p, 'token gives us our player back');
  const before = p.ps.pos.slice();
  h.input.buttons = IN.FORWARD;
  h.run(TICK_RATE);
  const moved = Math.hypot(p.ps.pos[0] - before[0], p.ps.pos[1] - before[1]);
  assert.ok(moved > 100, `server should move us after reconnecting (moved ${moved.toFixed(1)})`);
});

test('after a page reload (new game, same token) the server accepts our input at once', () => {
  const h = harness();
  h.run(5 * TICK_RATE);
  const p = h.me();
  h.drop();
  // a brand-new client starts counting commands from 0 ...
  const fresh = makeClient(h.world, h.transport, h.input);
  h.connect(fresh, p.token);
  // ... but the welcome tells it where to continue
  assert.ok(fresh.cmdNum >= p.lastCmdNum, `cmdNum ${fresh.cmdNum} should continue from ${p.lastCmdNum}`);
  const before = p.ps.pos.slice();
  h.input.buttons = IN.FORWARD;
  h.run(TICK_RATE, fresh);
  const moved = Math.hypot(p.ps.pos[0] - before[0], p.ps.pos[1] - before[1]);
  assert.ok(moved > 100, `server should move us after reloading (moved ${moved.toFixed(1)})`);
  // and the gun still fires (weapon timers count in commands)
  const ammo = p.ws.priClip + p.ws.secClip;
  h.input.buttons = IN.ATTACK;
  h.run(8, fresh);
  assert.ok(p.ws.priClip + p.ws.secClip < ammo, 'firing after a reload should use ammo');
});

test('a dropped player keeps standing for 10 s, then dies if they do not come back', () => {
  const h = harness();
  h.run(TICK_RATE);
  const p = h.me();
  h.drop();
  for (let i = 0; i < 9 * TICK_RATE; i++) h.server.step();
  assert.ok(p.alive, 'still alive 9 s after dropping');
  for (let i = 0; i < 2 * TICK_RATE; i++) h.server.step();
  assert.ok(!p.alive, 'dead after the 10 s grace period');
});

test('deathmatch is free-for-all: players on the same team can hurt each other', () => {
  const { world } = loadRealMap();
  const server = new MatchServer({ world, map: MAP, mode: 'deathmatch' });
  server.start = () => {};
  for (const name of ['A', 'B']) {
    server.connect({ send() {}, close() {} }).onMessage(JSON.stringify({ type: 'join', name, team: 'T' }));
  }
  const [a, b] = [...server.match.players.values()];
  assert.equal(a.team, b.team);
  assert.ok(server.match.canDamage(a, b), 'teammates can damage each other in deathmatch');
  const def = new MatchServer({ world, map: MAP, mode: 'defusal' });
  def.start = () => {};
  for (const name of ['A', 'B']) {
    def.connect({ send() {}, close() {} }).onMessage(JSON.stringify({ type: 'join', name, team: 'T' }));
  }
  const [c, d] = [...def.match.players.values()];
  assert.ok(!def.match.canDamage(c, d), 'bomb defusal keeps friendly fire off');
});

test('a player who sends nothing for 60 s is disconnected (idle tabs stop billing)', () => {
  const { world } = loadRealMap();
  const server = new MatchServer({ world, map: MAP, mode: 'deathmatch' });
  server.start = () => {};
  let closed = null;
  server.connect({ send() {}, close(code) { closed = code; } }).onMessage(JSON.stringify({ type: 'join', name: 'A' }));
  for (let i = 0; i < 59 * TICK_RATE; i++) server.step();
  assert.equal(closed, null);
  for (let i = 0; i < 2 * TICK_RATE; i++) server.step();
  assert.equal(closed, CLOSE_IDLE);
  assert.equal(server.match.connectedCount(), 0, 'nobody left: the tick loop can stop');
});

test('the prebuilt collision file traces exactly like collision built from the .glb', () => {
  const { world } = loadRealMap();
  const bytes = world.serialize({ test: true });
  const copy = CollisionWorld.deserialize(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const ta = createTrace(), tb = createTrace();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) {
    const s = [-2400 + rnd() * 4300, -1400 + rnd() * 5100, -150 + rnd() * 500];
    const e = [s[0] + (rnd() - 0.5) * 600, s[1] + (rnd() - 0.5) * 600, s[2] + (rnd() - 0.5) * 300];
    world.traceBox(s, e, [-16, -16, 0], [16, 16, 72], ta);
    copy.traceBox(s, e, [-16, -16, 0], [16, 16, 72], tb);
    assert.equal(ta.fraction, tb.fraction);
    assert.deepEqual(ta.endpos, tb.endpos);
  }
});
