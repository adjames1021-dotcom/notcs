// Netcode tests: run a real MatchServer and a real client Game in lockstep
// over a fake network with latency, and check that client prediction matches
// the server (no corrections needed), and that bundling sends 2 cmds/message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchServer } from '../public/shared/server.js';
import { Game } from '../public/js/game.js';
import { MAP } from '../public/config/map.js';
import { IN } from '../public/shared/usercmd.js';
import { loadRealMap } from './helpers.js';

/** A fake network: messages arrive after `latency` ticks, in order. */
function fakeNet(latencyTicks) {
  const up = [], down = [];
  let now = 0;
  return {
    up, down,
    setNow(t) { now = t; },
    clientTransport: {
      onmessage: null, onclose: null, sent: 0,
      send(data) { this.sent++; up.push({ at: now + latencyTicks, data }); },
      close() {},
    },
    serverConn: { send(data) { down.push({ at: now + latencyTicks, data }); }, close() {} },
    deliver(queue, fn) { while (queue.length && queue[0].at <= now) fn(queue.shift().data); },
  };
}

function makeClient(world, transport, inputState) {
  const stub = () => {};
  return new Game({
    renderer: { setView: stub, render: stub },
    input: inputState,
    transport,
    world,
    settings: {},
    hud: null,
    audio: { footstep: stub, land: stub, hurt: stub, setListener: stub },
    mode: 'test',
    players: null,
  });
}

function setup(latency) {
  const { world } = loadRealMap();
  const server = new MatchServer({ world, map: MAP, mode: 'practice' });
  server.start = () => {}; // we drive ticks by hand
  const net = fakeNet(latency);
  const session = server.connect(net.serverConn);
  const input = {
    buttons: 0, yaw: 90, pitch: 0,
    selectNext: 0, impulseNext: 0,
    sampleButtons() { return this.buttons; },
    takeSelect() { const v = this.selectNext; this.selectNext = 0; return v; },
    takeImpulse() { const v = this.impulseNext; this.impulseNext = 0; return v; },
  };
  const client = makeClient(world, net.clientTransport, input);
  net.clientTransport.onmessage = (d) => client.onMessage(d);
  session.onMessage(JSON.stringify({ type: 'join', name: 'bot' }));
  let t = 0;
  const run = (ticks, buttonsFn) => {
    for (let i = 0; i < ticks; i++, t++) {
      net.setNow(t);
      net.deliver(net.down, (d) => client.onMessage(d));
      if (buttonsFn) buttonsFn(i, input);
      client.tick();
      net.deliver(net.up, (d) => session.onMessage(d));
      server.step();
    }
  };
  return { server, client, net, input, run };
}

test('prediction matches the server exactly while running, jumping and hitting walls', () => {
  const { client, run } = setup(6); // ~94 ms each way
  run(64); // join + spawn + settle
  const base = client.stats.corrections;
  // run around for 8 seconds: forward/strafe/jump/crouch, turning
  run(512, (i, inp) => {
    inp.yaw = 90 + Math.sin(i / 40) * 120;
    inp.buttons = IN.FORWARD | (i % 90 < 30 ? IN.MOVELEFT : 0) | (i % 64 === 10 ? IN.JUMP : 0) | (i % 200 > 170 ? IN.DUCK : 0);
  });
  run(64);
  assert.equal(client.stats.corrections - base, 0, `corrections: ${client.stats.corrections - base}, last error ${client.stats.lastError}`);
  assert.ok(client.alive);
});

test('client bundles 2 ticks of input per message (32 msg/s)', () => {
  const { net, run } = setup(2);
  run(16); // wait for the welcome message
  const before = net.clientTransport.sent;
  run(64);
  assert.equal(net.clientTransport.sent - before, 32);
});

test('a server-side teleport is corrected on the client', () => {
  const { server, client, run } = setup(4);
  run(64);
  const p = [...server.match.players.values()].find((q) => !q.dummy);
  p.ps.pos = [-544, 2220, -120]; // move them to CT spawn
  p.ps.onGround = false;
  run(40);
  assert.ok(Math.abs(client.pred.pos[0] - p.ps.pos[0]) < 1, `client x ${client.pred.pos[0]} vs server ${p.ps.pos[0]}`);
  assert.ok(Math.abs(client.pred.pos[1] - p.ps.pos[1]) < 1);
});

test('prediction matches the server while shooting, reloading, switching and knifing', () => {
  const { client, run } = setup(5);
  run(80);
  const base = client.stats.corrections;
  // spray, release, reload, switch to pistol, tap, knife, back to rifle (Q)
  run(400, (i, inp) => {
    inp.yaw = 90 + Math.sin(i / 50) * 40;
    let b = 0;
    if (i < 60) b |= 128; // IN.ATTACK
    if (i === 70) b |= 512; // IN.RELOAD
    if (i > 250 && i < 300 && i % 10 < 2) b |= 128;
    if (i > 320 && i < 340) b |= 128;
    if (i > 345 && i < 350) b |= 256; // IN.ATTACK2
    inp.buttons = b;
    inp.selectNext = i === 240 ? 2 : i === 310 ? 3 : 0;
    inp.impulseNext = i === 360 ? 2 : 0; // last weapon
  });
  run(64);
  assert.equal(client.stats.corrections - base, 0, `corrections ${client.stats.corrections - base}`);
});
