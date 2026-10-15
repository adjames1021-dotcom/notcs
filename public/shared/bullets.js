// ---------------------------------------------------------------------------
// bullets.js — hitscan bullets: map hits, wallbangs (penetration), players,
// damage falloff, hit groups and armor. Used by the server to decide damage
// and by the browser to predict where bullet holes appear.
// ---------------------------------------------------------------------------

import { createTrace } from './collision.js';
import { HITGROUP, HITGROUP_MULT } from './weapons.js';

const MAX_PENETRATIONS = 4;
const MAX_WALL_THICKNESS = 64; // nothing thicker can be shot through
const MATERIAL_PEN_MOD = 0.75; // the map has no material info; TODO: per-material values
const PLAYER_PEN_DAMAGE_KEEP = 0.6; // damage kept after passing through a body TODO

const trA = createTrace();
const trB = createTrace();

/**
 * Fire one bullet.
 * @param world   CollisionWorld
 * @param origin  eye position
 * @param dir     normalized direction
 * @param def     weapon definition
 * @param testPlayers (start, dir, maxDist, exclude:Set) => {t, id, group} | null
 * @returns { impacts: [{pos, normal, exit}], hits: [{id, group, damage, dist}], end }
 */
export function traceBullet(world, origin, dir, def, testPlayers = null, shooterId = 0) {
  const impacts = [];
  const hits = [];
  const exclude = new Set([shooterId]);
  let start = origin.slice();
  let remaining = def.range || 8192;
  let traveled = 0;
  let damage = def.damage;
  let pens = def.penetration > 0 ? MAX_PENETRATIONS : 0;
  let end = null;

  for (let guard = 0; guard < 12 && remaining > 0 && damage >= 1; guard++) {
    const stop = [start[0] + dir[0] * remaining, start[1] + dir[1] * remaining, start[2] + dir[2] * remaining];
    world.traceRay(start, stop, trA);
    const wallDist = trA.hit ? trA.fraction * remaining : remaining;

    // players in front of the wall?
    const ph = testPlayers ? testPlayers(start, dir, wallDist, exclude) : null;
    if (ph) {
      const dist = traveled + ph.t;
      const dmg = damage * Math.pow(def.rangeMod, dist / 500);
      hits.push({ id: ph.id, group: ph.group, damage: dmg, dist, pos: [start[0] + dir[0] * ph.t, start[1] + dir[1] * ph.t, start[2] + dir[2] * ph.t] });
      exclude.add(ph.id);
      damage *= PLAYER_PEN_DAMAGE_KEEP;
      // keep going from where we hit them (they're excluded now)
      continue;
    }
    if (!trA.hit) { end = stop; break; }

    const entry = trA.endpos.slice();
    impacts.push({ pos: entry, normal: trA.normal.slice(), exit: false });
    traveled += wallDist;
    remaining -= wallDist;
    end = entry;
    if (pens-- <= 0) break;

    // Find where the bullet comes out of this wall.
    const exit = findExit(world, entry, dir, Math.min(MAX_WALL_THICKNESS, remaining));
    if (!exit) break;
    const thickness = exit.dist;
    damage -= penetrationLoss(damage, def.penetration, thickness);
    if (damage < 1) break;
    impacts.push({ pos: exit.pos, normal: exit.normal, exit: true });
    traveled += thickness;
    remaining -= thickness;
    start = [exit.pos[0] + dir[0] * 0.1, exit.pos[1] + dir[1] * 0.1, exit.pos[2] + dir[2] * 0.1];
  }
  return { impacts, hits, end: end || start };
}

/** Walk forward from the entry hole until we leave the solid (a back face). */
function findExit(world, entry, dir, maxDist) {
  let t = 0.25;
  for (let i = 0; i < 6 && t < maxDist; i++) {
    const s = [entry[0] + dir[0] * t, entry[1] + dir[1] * t, entry[2] + dir[2] * t];
    const e = [entry[0] + dir[0] * maxDist, entry[1] + dir[1] * maxDist, entry[2] + dir[2] * maxDist];
    world.traceRay(s, e, trB);
    if (!trB.hit) return null; // never came out: too thick or open-ended geometry
    const d = t + trB.fraction * (maxDist - t);
    if (trB.backface) return { pos: trB.endpos.slice(), normal: trB.normal.slice(), dist: d };
    t = d + 0.25; // hit another front face inside; keep looking
  }
  return null;
}

/** CS:GO-style damage lost when going through a wall. */
export function penetrationLoss(damage, power, thickness) {
  const penMod = 1 / MATERIAL_PEN_MOD;
  const chunk = damage * 0.15;
  const weaponMod = chunk + Math.max(0, (3 / Math.max(0.5, power)) * 1.25) * (penMod * 3.0);
  const objectLoss = (penMod * thickness * thickness) / 24;
  return weaponMod + objectLoss;
}

/**
 * Apply hit group multiplier and armor.
 * @returns { health, armor } damage to subtract from health and armor
 */
export function computeDamage(rawDamage, group, armorPen, victim) {
  let dmg = rawDamage * (HITGROUP_MULT[group] ?? 1);
  let armorLoss = 0;
  const legs = group === HITGROUP.LEFTLEG || group === HITGROUP.RIGHTLEG;
  const armored = victim.armor > 0 && !legs && (group !== HITGROUP.HEAD || victim.helmet);
  if (armored) {
    const ratio = armorPen / 100;
    let newDmg = dmg * ratio;
    let armorDmg = (dmg - newDmg) * 0.5;
    if (armorDmg > victim.armor) {
      armorDmg = victim.armor;
      newDmg = dmg - armorDmg / 0.5;
    }
    dmg = newDmg;
    armorLoss = armorDmg;
  }
  return { health: Math.max(0, Math.floor(dmg)), armor: Math.floor(armorLoss) };
}
