// ---------------------------------------------------------------------------
// economy.js — CS2 money rules and buying (server decides; the buy menu just
// asks). Round win/loss money is applied by the round rules (rules.js).
// ---------------------------------------------------------------------------

import { WEAPONS, EQUIPMENT, MAX_GRENADES } from './weapons.js';
import { giveWeapon, grenadeCount, SLOT, switchTo, removeSlot, bestSlot, hasSlot } from './weaponLogic.js';

export const ECONOMY = {
  START_MONEY: 800,
  MAX_MONEY: 16000,
  WIN_ELIMINATION: 3250,
  WIN_TIME: 3250,
  WIN_BOMB_EXPLODED: 3500,
  WIN_BOMB_DEFUSED: 3500,
  LOSS_BONUS: [1400, 1900, 2400, 2900, 3400], // by consecutive losses
  LOSS_PLANTED_BONUS: 800, // Ts get this extra if they planted but lost
  PLANT_REWARD: 300,
  DEFUSE_REWARD: 300,
  TEAMKILL_PENALTY: -300,
  BUY_TIME: 20, // seconds after freeze time
  PRACTICE_MONEY: 16000,
};

export function addMoney(p, amount) {
  p.money = Math.max(0, Math.min(ECONOMY.MAX_MONEY, p.money + amount));
}

/** Kill reward for the weapon used (CS2 values). */
export function killReward(weaponId) {
  const def = WEAPONS[weaponId];
  return def ? def.killReward ?? 300 : 300;
}

/** Every buyable item, with price and team restriction, for the buy menu. */
export function buyList(teamName) {
  const out = [];
  for (const def of Object.values(WEAPONS)) {
    if (!def.price || def.cls === 'knife' || def.cls === 'c4') continue;
    out.push({ id: def.id, name: def.name, price: def.price, cls: def.cls, slot: def.slot, team: def.team, available: !def.team || def.team === teamName });
  }
  for (const [id, e] of Object.entries(EQUIPMENT)) {
    out.push({ id, name: e.name, price: e.price, cls: 'equipment', slot: 'equipment', team: e.team || null, available: !e.team || e.team === teamName });
  }
  return out;
}

/**
 * Try to buy something. Returns { ok, reason, dropped }.
 * `teamName` is 'T' or 'CT'. Doesn't check buy zone/time (the caller does).
 */
export function tryBuy(p, item, teamName) {
  const ws = p.ws;
  if (EQUIPMENT[item]) {
    const e = EQUIPMENT[item];
    if (e.team && e.team !== teamName) return { ok: false, reason: 'Not available for your team' };
    let price = e.price;
    if (item === 'vest') {
      if (p.armor >= 100) return { ok: false, reason: 'You already have full armor' };
    } else if (item === 'vesthelm') {
      if (p.armor >= 100 && p.helmet) return { ok: false, reason: 'You already have armor and a helmet' };
      if (p.armor >= 100) price = EQUIPMENT.helmet.price; // only the helmet is missing
    } else if (item === 'helmet') {
      if (p.helmet) return { ok: false, reason: 'You already have a helmet' };
      if (p.armor <= 0) return { ok: false, reason: 'Buy armor first' };
    } else if (item === 'defuser') {
      if (p.defuser) return { ok: false, reason: 'You already have a defuse kit' };
    }
    if (p.money < price) return { ok: false, reason: 'Not enough money' };
    p.money -= price;
    if (item === 'vest') p.armor = 100;
    if (item === 'vesthelm') { p.armor = 100; p.helmet = true; }
    if (item === 'helmet') p.helmet = true;
    if (item === 'defuser') p.defuser = true;
    return { ok: true, price };
  }
  const def = WEAPONS[item];
  if (!def || !def.price) return { ok: false, reason: 'Unknown item' };
  if (def.team && def.team !== teamName) return { ok: false, reason: 'Not available for your team' };
  if (p.money < def.price) return { ok: false, reason: 'Not enough money' };
  if (def.slot === 'grenade') {
    if (grenadeCount(ws) >= MAX_GRENADES) return { ok: false, reason: 'You can\'t carry any more grenades' };
  }
  if (def.slot === 'zeus' && ws.zeus) return { ok: false, reason: 'You already have a Zeus' };
  // already holding exactly this gun: just refill nothing (CS2 doesn't allow)
  if ((def.slot === 'primary' && ws.pri === def.index) || (def.slot === 'secondary' && ws.sec === def.index)) {
    return { ok: false, reason: 'You already have this weapon' };
  }
  const res = giveWeapon(ws, def.id);
  if (!res.ok) return { ok: false, reason: 'You can\'t carry any more of those' };
  p.money -= def.price;
  // switch to what you bought (like CS)
  if (def.slot === 'primary') switchTo(ws, SLOT.PRIMARY);
  else if (def.slot === 'secondary') switchTo(ws, SLOT.SECONDARY);
  return { ok: true, price: def.price, dropped: res.dropped };
}

const NADE_SLOT = { he: SLOT.HE, flash: SLOT.FLASH, smoke: SLOT.SMOKE, molotov: SLOT.FIRE, incendiary: SLOT.FIRE, decoy: SLOT.DECOY };

/**
 * What to remember about a purchase so it can be refunded (CS2: right-click
 * an item in the buy menu to sell it back while you can still buy).
 */
export function buyRecord(p, item, price, before) {
  return { item, price, prevArmor: before.armor, prevHelmet: before.helmet };
}

/**
 * Undo a purchase if the item is still unused. Returns true if it was taken
 * back (the caller gives the money back).
 */
export function refundItem(p, rec) {
  const ws = p.ws;
  if (EQUIPMENT[rec.item]) {
    if (rec.item === 'defuser') {
      if (!p.defuser) return false;
      p.defuser = false;
      return true;
    }
    if (p.armor < 100) return false; // it has been shot at
    p.armor = rec.prevArmor;
    p.helmet = rec.prevHelmet;
    return true;
  }
  const def = WEAPONS[rec.item];
  if (!def) return false;
  let slot;
  if (def.slot === 'primary') {
    if (ws.pri !== def.index || ws.priClip !== def.clip || ws.priRes !== def.reserve) return false;
    slot = SLOT.PRIMARY;
  } else if (def.slot === 'secondary') {
    if (ws.sec !== def.index || ws.secClip !== def.clip || ws.secRes !== def.reserve) return false;
    slot = SLOT.SECONDARY;
  } else if (def.slot === 'zeus') {
    if (!ws.zeus || ws.zeusClip !== 1) return false;
    slot = SLOT.ZEUS;
  } else if (def.slot === 'grenade') {
    slot = NADE_SLOT[def.id];
    if (slot === SLOT.FIRE ? ws.fire !== def.index : !ws[def.id]) return false;
  } else return false;
  removeSlot(ws, slot);
  if (!hasSlot(ws, ws.active)) switchTo(ws, bestSlot(ws));
  if (!hasSlot(ws, ws.last)) ws.last = SLOT.KNIFE;
  return true;
}

/** Is a point inside an axis-aligned box {min, max}? */
export function inBox(pos, box) {
  return !!box && pos[0] >= box.min[0] && pos[0] <= box.max[0] && pos[1] >= box.min[1] && pos[1] <= box.max[1] &&
    pos[2] >= box.min[2] && pos[2] <= box.max[2];
}
