// ---------------------------------------------------------------------------
// loadout.js — what the buy menu (B) shows, CS2-style.
//
// Like CS2, each side has 5 pistol slots, 5 mid-tier slots and 5 rifle slots,
// and you choose which weapon goes in each one. These are the defaults; in
// game, click LOADOUT in the buy menu to swap a slot (saved in your browser).
// Slot 1 of the pistols is your starting pistol.
//
// The server lets you buy anything your team can use; the loadout only
// decides what the menu shows and which number key buys it.
// ---------------------------------------------------------------------------

import { WEAPONS } from '../shared/weapons.js';

export const DEFAULT_LOADOUT = {
  T: {
    pistols: ['glock', 'elite', 'p250', 'tec9', 'deagle'],
    mid: ['mac10', 'mp7', 'ump45', 'p90', 'nova'], // TODO: check against CS2's current default mid-tier
    rifles: ['galil', 'ak47', 'ssg08', 'sg553', 'awp'],
  },
  CT: {
    pistols: ['usps', 'elite', 'p250', 'fiveseven', 'deagle'],
    mid: ['mp9', 'mp7', 'ump45', 'p90', 'nova'], // TODO: check against CS2's current default mid-tier
    rifles: ['famas', 'm4a4', 'ssg08', 'aug', 'awp'],
  },
};

// Equipment and grenade columns are fixed in CS2.
export const EQUIPMENT_COLUMN = {
  T: ['vest', 'vesthelm', 'zeus'],
  CT: ['vest', 'vesthelm', 'zeus', 'defuser'],
};
export const GRENADE_COLUMN = {
  T: ['molotov', 'decoy', 'flash', 'he', 'smoke'],
  CT: ['incendiary', 'decoy', 'flash', 'he', 'smoke'],
};

export const STARTING_PISTOLS = { T: ['glock'], CT: ['usps', 'p2000'] };

const TIER_CLASSES = {
  pistols: ['pistol'],
  mid: ['smg', 'shotgun', 'heavy'],
  rifles: ['rifle', 'sniper'],
};

/** Weapons that may go in slot `index` of `tier` for `team`. */
export function slotOptions(tier, index, team) {
  if (tier === 'pistols' && index === 0) return STARTING_PISTOLS[team].slice();
  return Object.values(WEAPONS)
    .filter((d) => d.price && TIER_CLASSES[tier].includes(d.cls) && (!d.team || d.team === team))
    .filter((d) => !(tier === 'pistols' && STARTING_PISTOLS[team].includes(d.id)))
    .sort((a, b) => a.price - b.price)
    .map((d) => d.id);
}

const KEY = 'notcs.loadout.v1';

/** Your loadout (defaults + whatever you changed), checked for bad entries. */
export function loadLoadout() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const out = {};
  for (const team of ['T', 'CT']) {
    out[team] = {};
    for (const tier of ['pistols', 'mid', 'rifles']) {
      const list = DEFAULT_LOADOUT[team][tier].slice();
      const mine = saved[team] && saved[team][tier];
      if (Array.isArray(mine)) {
        mine.slice(0, 5).forEach((id, i) => {
          if (slotOptions(tier, i, team).includes(id) && !list.some((x, k) => k !== i && x === id)) list[i] = id;
        });
      }
      out[team][tier] = list;
    }
  }
  return out;
}

export function saveLoadout(loadout) {
  try { localStorage.setItem(KEY, JSON.stringify(loadout)); } catch { /* private mode */ }
}
