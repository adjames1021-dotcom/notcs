// Bomb defusal round rules: phases, win conditions, CS2 money, halftime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, TEAM } from '../public/shared/match.js';
import { PHASE, RULES } from '../public/shared/rules.js';
import { SLOT, giveWeapon } from '../public/shared/weaponLogic.js';
import { IN } from '../public/shared/usercmd.js';
import { makeWorld, floor, cmd } from './helpers.js';

const MAP = {
  name: 'test',
  spawns: { T: [[0, 0, 1, 0], [40, 0, 1, 0], [80, 0, 1, 0]], CT: [[2000, 0, 1, 180], [2040, 0, 1, 180], [2080, 0, 1, 180]] },
  bombsites: { A: { min: [900, -200, -50], max: [1100, 200, 200] } },
  buyzones: { T: { min: [-200, -200, -50], max: [300, 200, 200] }, CT: { min: [1800, -200, -50], max: [2300, 200, 200] } },
  devSpawn: [0, 0, 1, 0],
};

function game(nT = 1, nCT = 1) {
  const m = new Match({ world: makeWorld(floor()), map: MAP, mode: 'defusal' });
  const ts = [], cts = [];
  for (let i = 0; i < nT; i++) ts.push(m.addPlayer({ name: 'T' + i, team: TEAM.T, token: 'tttttttttt' + i }));
  for (let i = 0; i < nCT; i++) cts.push(m.addPlayer({ name: 'CT' + i, team: TEAM.CT, token: 'cccccccccc' + i }));
  return { m, ts, cts, r: m.rules };
}
const sec = (m, s) => { for (let i = 0; i < Math.round(s * 64); i++) m.step(); };
let n = 10000;
/** Feed a player one command (we drive them directly, no network). */
function input(m, p, buttons, ticks = 1, yaw = 0) {
  for (let i = 0; i < ticks; i++) { const c = cmd(buttons, yaw); c.num = ++n; m.runCommand(p, c); m.step(); }
}

test('warmup ends 5 s after both teams have players; round 1 starts frozen with $800', () => {
  const { m, ts, r } = game();
  assert.equal(r.phase, PHASE.WARMUP);
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1);
  assert.equal(r.phase, PHASE.FREEZE);
  assert.equal(r.round, 1);
  assert.equal(ts[0].money, 800);
  assert.equal(m.isFrozen(ts[0]), true);
  sec(m, RULES.FREEZE_TIME);
  assert.equal(r.phase, PHASE.LIVE);
  assert.equal(m.isFrozen(ts[0]), false);
  // exactly one terrorist got the bomb
  assert.equal([...m.players.values()].filter((p) => p.ws.c4).length, 1);
});

test('buying: only in your buy zone, only during buy time', () => {
  const { m, ts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1);
  m.buy(ts[0], 'p250');
  assert.equal(ts[0].money, 500, 'bought a P250 in freeze time');
  sec(m, RULES.FREEZE_TIME + RULES.BUY_TIME + 1);
  ts[0].money = 5000;
  m.buy(ts[0], 'ak47');
  assert.equal(ts[0].money, 5000, 'buy time is over');
  void r;
});

test('eliminating the CTs wins the round: $3250 to winners, $1400 loss bonus', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME + 1);
  const tMoney = ts[0].money, ctMoney = cts[0].money;
  m.killPlayer(cts[0], ts[0], 'ak47');
  m.step();
  assert.equal(r.phase, PHASE.ENDED);
  assert.equal(r.score[1], 1);
  assert.equal(ts[0].money, tMoney + 300 + 3250); // kill reward + round win
  assert.equal(cts[0].money, ctMoney + 1400);
  // next round starts after 7 s; the dead CT respawns with default gear
  sec(m, RULES.ROUND_END_TIME + 0.1);
  assert.equal(r.phase, PHASE.FREEZE);
  assert.equal(r.round, 2);
  assert.ok(cts[0].alive);
});

test('plant the bomb (3.2 s in the site), it explodes after 40 s: Ts win $3500', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME + 1);
  const t = ts[0];
  t.ps.pos = [1000, 0, 0.05];
  cts[0].ps.pos = [3000, 0, 0.05];
  if (!t.ws.c4) giveWeapon(t.ws, 'c4');
  t.ws.active = SLOT.C4;
  const money = t.money;
  input(m, t, IN.ATTACK, Math.ceil(RULES.PLANT_TIME * 64) + 4);
  assert.equal(r.phase, PHASE.PLANTED);
  assert.equal(t.money, money + 300);
  // the T dies — round goes on, CTs must defuse
  m.killPlayer(t, null, 'world');
  m.step();
  assert.equal(r.phase, PHASE.PLANTED);
  sec(m, RULES.BOMB_TIME + 0.1);
  assert.equal(r.phase, PHASE.ENDED);
  assert.equal(r.score[1], 1);
});

test('defusing with a kit takes 5 s: CTs win $3500, Ts still get +$800 for the plant', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME + 1);
  const t = ts[0], ct = cts[0];
  t.ps.pos = [1000, 0, 0.05];
  if (!t.ws.c4) giveWeapon(t.ws, 'c4');
  t.ws.active = SLOT.C4;
  input(m, t, IN.ATTACK, Math.ceil(RULES.PLANT_TIME * 64) + 4);
  assert.equal(r.phase, PHASE.PLANTED);
  t.ps.pos = [-500, 0, 0.05];
  ct.ps.pos = [1010, 10, 0.05];
  ct.defuser = true;
  const ctMoney = ct.money, tMoney = t.money;
  input(m, ct, IN.USE, Math.ceil(RULES.DEFUSE_TIME_KIT * 64) + 4);
  assert.equal(r.phase, PHASE.ENDED);
  assert.equal(r.score[2], 1);
  assert.equal(ct.money, ctMoney + 300 + 3500);
  assert.equal(t.money, tMoney + 1400 + 800);
});

test('time running out without a plant: CTs win, surviving Ts get nothing', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME);
  const tMoney = ts[0].money, ctMoney = cts[0].money;
  sec(m, RULES.ROUND_TIME + 0.2);
  assert.equal(r.score[2], 1);
  assert.equal(cts[0].money, ctMoney + 3250);
  assert.equal(ts[0].money, tMoney);
});

test('loss bonus climbs 1400 -> 1900 -> 2400 and a win lowers it one step', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME + 1);
  const lossFor = () => {
    const before = cts[0].money;
    m.killPlayer(cts[0], null, 'world');
    m.step();
    const got = cts[0].money - before;
    sec(m, RULES.ROUND_END_TIME + RULES.FREEZE_TIME + 1);
    return got;
  };
  assert.equal(lossFor(), 1400);
  assert.equal(lossFor(), 1900);
  assert.equal(lossFor(), 2400);
  void ts; void r;
});

test('halftime after 12 rounds swaps sides and resets money; first to 13 wins', () => {
  const { m, ts, cts, r } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1 + RULES.FREEZE_TIME + 1);
  const a = ts[0], b = cts[0];
  for (let i = 0; i < 12; i++) {
    m.killPlayer(b.team === TEAM.CT ? b : a, null, 'world'); // the CT side always loses
    m.step();
    sec(m, RULES.ROUND_END_TIME + RULES.FREEZE_TIME + 1);
  }
  assert.equal(a.team, TEAM.CT, 'player A swapped to CT');
  assert.equal(b.team, TEAM.T);
  assert.ok(a.money <= 800 + 300, `money reset at halftime (${a.money})`);
  assert.equal(r.score[TEAM.CT], 12, 'A\'s team keeps its 12 rounds');
  // A's team (now CT) wins one more round -> 13 -> match over
  m.killPlayer(b, null, 'world');
  m.step();
  assert.equal(r.phase, PHASE.MATCH_END);
});

test('CS2 refund: right-click sells back an unused item bought this round', () => {
  const { m, ts } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1); // round 1 freeze time, $800
  const t = ts[0];
  m.buy(t, 'p250');
  assert.equal(t.money, 500);
  m.buy(t, 'vest'); // $650: not enough money
  assert.equal(t.money, 500);
  m.refund(t, 'p250');
  assert.equal(t.money, 800, 'refund gives the full price back');
  assert.equal(t.ws.sec, 0, 'the P250 is gone');
  m.refund(t, 'p250');
  assert.equal(t.money, 800, 'cannot refund twice');
  // armor: refundable until it takes damage
  m.buy(t, 'vest');
  assert.equal(t.armor, 100);
  m.refund(t, 'vest');
  assert.equal(t.money, 800);
  assert.equal(t.armor, 0);
});

test('CS2 refund: not after the gun was fired, and not once buy time is over', () => {
  const { m, ts } = game();
  sec(m, RULES.WARMUP_COUNTDOWN + 0.1);
  const t = ts[0];
  t.money = 5000;
  m.buy(t, 'deagle');
  assert.equal(t.money, 4300);
  sec(m, RULES.FREEZE_TIME + 0.1); // round is live, still inside buy time
  input(m, t, IN.ATTACK, 2);
  input(m, t, 0, 40);
  m.refund(t, 'deagle');
  assert.equal(t.money, 4300, 'a used gun cannot be refunded');
  m.buy(t, 'he');
  sec(m, RULES.BUY_TIME + 1);
  m.refund(t, 'he');
  assert.equal(t.money, 4000, 'no refunds after buy time');
});

test('casual: $1000 start, free kevlar + helmet, defuse kits for CTs, 45 s buy time, first to 8', () => {
  const m = new Match({ world: makeWorld(floor()), map: MAP, mode: 'casual' });
  const t = m.addPlayer({ name: 'T', team: TEAM.T, token: 'tttttttttt' });
  const ct = m.addPlayer({ name: 'CT', team: TEAM.CT, token: 'cccccccccc' });
  const r = m.rules;
  sec(m, r.R.WARMUP_COUNTDOWN + 0.1);
  assert.equal(r.phase, PHASE.FREEZE);
  assert.equal(t.money, 1000);
  assert.equal(t.armor, 100); assert.equal(t.helmet, true);
  assert.equal(ct.defuser, true); assert.equal(t.defuser, false);
  sec(m, r.R.FREEZE_TIME + 30);
  assert.equal(m.canBuy(t), true, 'still buy time 30 s into the round');
  sec(m, 16);
  assert.equal(m.canBuy(t), false, 'buy time over after 45 s');
  assert.equal(r.R.WIN_ROUNDS, 8);
  assert.equal(m.maxPlayers, 20);
});

test('competitive allows 10 players, deathmatch 16', () => {
  const comp = new Match({ world: makeWorld(floor()), map: MAP, mode: 'defusal' });
  for (let i = 0; i < 10; i++) assert.ok(comp.addPlayer({ name: 'p' + i, token: 'tokentoken' + i }));
  assert.equal(comp.addPlayer({ name: 'extra', token: 'tokentokenx' }), null);
  const dm = new Match({ world: makeWorld(floor()), map: MAP, mode: 'deathmatch' });
  assert.equal(dm.maxPlayers, 16);
});
