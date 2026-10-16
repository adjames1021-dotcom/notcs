// ---------------------------------------------------------------------------
// config/map.js — EVERYTHING about the map you might want to tweak.
// Positions are in Hammer units (X = east, Y = north, Z = up), exactly what
// you see in Hammer's status bar. Your .glb has no entities, so spawns,
// bombsites and buy zones live here instead.
//
// Tip: in game, press F3 to show your current position — walk somewhere and
// copy the numbers into this file.
// ---------------------------------------------------------------------------

export const MAP = {
  name: 'de_dust2',
  file: '/maps/de_dust2.glb',

  // >>> MAP_SCALE <<<
  // Multiply the .glb's units by this to get Hammer units.
  // 1     = the file is already in Hammer units (this map is).
  // 39.37 = the exporter converted to meters.
  // 1     = (inches are the same as Hammer units).
  // The console prints the map's bounding box when it loads so you can check.
  MAP_SCALE: 1,

  // Which way is "up" in the .glb. 'auto' measures floor area to find out.
  // Force one of '+y', '-y', '+z', '-z', '+x', '-x' if the map loads sideways.
  UP_AXIS: 'auto',
  // Set to true if the map looks mirrored (A and B sites swapped).
  MIRROR_X: false,
  // Wrapper nodes whose rotation should be ignored (Sketchfab adds one).
  IGNORE_NODE_TRANSFORMS: ['Sketchfab_model'],

  // Meshes/materials whose names match these become invisible collision
  // (player clips, nodraw, tool textures, skybox walls).
  COLLISION_ONLY_PATTERN: /clip|nodraw|tools|skybox|invisible/i,
  // Meshes matching this are ignored completely (triggers, etc).
  SKIP_PATTERN: /trigger|toolstrigger|hint|areaportal|occluder/i,
  // Meshes smaller than this (in units) don't collide, so you don't snag on
  // tiny decorations.
  TINY_MESH_SIZE: 6,

  // Spawn points: [x, y, z (feet), yaw in degrees]. The game drops each
  // spawn onto the floor below it, so z only needs to be roughly right.
  spawns: {
    T: [
      [-1272, -800, 130, 90],
      [-1208, -840, 130, 90],
      [-1336, -840, 130, 90],
      [-1208, -760, 130, 90],
      [-1336, -760, 130, 90],
      [-1144, -800, 130, 90],
      [-1400, -800, 130, 90],
      [-1144, -720, 130, 90],
      [-1400, -720, 130, 90],
      [-1272, -720, 130, 90],
    ],
    CT: [
      [-544, 2220, -126, 270],
      [-608, 2180, -126, 270],
      [-480, 2180, -126, 270],
      [-608, 2260, -126, 270],
      [-480, 2260, -126, 270],
      [-640, 2220, -126, 270],
      [-448, 2220, -126, 270],
      [-544, 2290, -126, 270],
    ],
  },

  // Axis-aligned boxes (min/max corners) where the bomb can be planted.
  bombsites: {
    A: { min: [1000, 2350, -20], max: [1600, 3050, 260] },
    B: { min: [-2150, 2350, -40], max: [-1500, 3050, 200] },
  },
  // Where each team can open the buy menu during buy time.
  buyzones: {
    T: { min: [-2250, -1100, 0], max: [-400, -550, 400] },
    CT: { min: [-1000, 1900, -200], max: [-200, 2600, 200] },
  },

  // Where you appear in Practice mode.
  devSpawn: [-1272, -800, 130, 90],
};
