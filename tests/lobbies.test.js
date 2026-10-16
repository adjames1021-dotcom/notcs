// Lobby finder: the directory Durable Object and the summaries lobbies send it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LobbyDirectory } from '../src/lobbies-do.js';
import { MatchServer } from '../public/shared/server.js';
import { MAP } from '../public/config/map.js';
import { makeWorld, floor } from './helpers.js';

const report = (dir, info) => dir.fetch(new Request('https://lobbies/report', { method: 'POST', body: JSON.stringify(info) }));
const list = async (dir) => (await (await dir.fetch(new Request('https://lobbies/list'))).json()).lobbies;

test('lobbies report themselves and show up in the list, busiest first', async () => {
  const dir = new LobbyDirectory({}, {});
  await report(dir, { code: 'alpha', mode: 'casual', map: 'de_dust2', players: 3, max: 20, phase: 'warmup' });
  await report(dir, { code: 'bravo', mode: 'deathmatch', map: 'de_dust2', players: 7, max: 16, phase: 'live' });
  const l = await list(dir);
  assert.deepEqual(l.map((x) => x.code), ['bravo', 'alpha']);
  assert.equal(l[1].mode, 'casual');
  assert.equal(l[1].players, 3);
});

test('an empty lobby disappears; one that stops reporting expires', async () => {
  const dir = new LobbyDirectory({}, {});
  await report(dir, { code: 'alpha', mode: 'defusal', players: 2, max: 10 });
  await report(dir, { code: 'bravo', mode: 'defusal', players: 1, max: 10 });
  await report(dir, { code: 'alpha', mode: 'defusal', players: 0, max: 10 });
  dir.lobbies.get('bravo').updated -= 60000; // pretend it went quiet a minute ago
  assert.deepEqual(await list(dir), []);
});

test('bad reports are rejected', async () => {
  const dir = new LobbyDirectory({}, {});
  assert.equal((await report(dir, { code: '../x', players: 1 })).status, 400);
  await report(dir, { code: 'ok', mode: 'hack', players: 1e9, max: 'x' });
  const [l] = await list(dir);
  assert.equal(l.mode, 'defusal');
  assert.equal(l.players, 64);
});

test('a lobby summary has the mode, player count and round', () => {
  const server = new MatchServer({ world: makeWorld(floor()), map: { ...MAP, spawns: { T: [[0, 0, 1, 0]], CT: [[200, 0, 1, 0]] } }, mode: 'casual' });
  server.start = () => {};
  server.connect({ send() {}, close() {} }).onMessage(JSON.stringify({ type: 'join', name: 'a' }));
  const s = server.summary();
  assert.equal(s.mode, 'casual');
  assert.equal(s.players, 1);
  assert.equal(s.max, 20);
  assert.equal(s.phase, 'warmup');
});
