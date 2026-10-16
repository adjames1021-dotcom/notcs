// ---------------------------------------------------------------------------
// random.js — a seeded random number generator. Spread for each bullet is
// generated from (player, command number, pellet), so the browser and the
// server produce the SAME random spread — your predicted bullet holes match
// where the server says you hit.
// ---------------------------------------------------------------------------

export function hashSeed(a, b, c = 0) {
  let h = 2166136261 >>> 0;
  for (const v of [a, b, c]) {
    h ^= v & 0xffff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for spread. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
