# notcs — file-by-file guide

This explains what every file does and where it lives, plus how the pieces
talk to each other. You don't need to read it to play; it's for when you want
to change things.

> Free fan project. It will never be sold or monetized, and it isn't
> affiliated with Valve.

## The big idea

The **game rules live in one place**: `public/shared/`. Both of these run that
same code:

- **The browser** runs it to *predict* your movement and shots instantly.
- **The server** runs it to decide what *really* happened. Online, the server is
  a Cloudflare Durable Object; in Practice mode it runs inside your tab.

Because it's identical JavaScript fed identical inputs, the prediction normally
matches the server exactly. The tests prove it: 8 seconds of running, jumping,
shooting and reloading with zero corrections.

```
 your browser                                          Cloudflare
 ─────────────                                         ──────────
 input.js  ──► usercmd (keys + view angles) ──┐
                                              │  2 ticks per message
 game.js: predict with shared/movement.js     │  (32 msg/s)
          + shared/weaponLogic.js             ▼
                                        src/worker.js ──► src/match-do.js
                                                           (one per lobby code)
                                                              │ MatchServer (shared/server.js)
                                                              │ Match (shared/match.js) at 64 tick
          ◄──── snapshot every tick ──────────────────────────┘
 game.js: reconcile (rewind + replay if the server disagrees)
          interpolate other players 100 ms in the past
 render/*: draw it, presentation.js: effects + sounds
```

## Netcode in one page

1. **Inputs only.** Every 1/64 s the browser builds a *usercmd*: buttons, view
   angles, weapon choice and the time it is showing other players. It never
   sends positions. Two usercmds go in each message, because Cloudflare bills
   incoming messages.
2. **Prediction.** The browser runs the shared movement and weapon code on that
   usercmd straight away, so movement and muzzle flashes have no delay. It
   keeps a history of the commands the server hasn't confirmed yet.
3. **Authority.** The Durable Object runs the same usercmds through the same
   code. It decides positions, hits, damage and money.
4. **Snapshots.** Every tick the server sends each player two things:
   - their own exact state, at full precision, together with the number of
     the last usercmd it processed (the *ack*)
   - only what changed about the other players (*delta compression*)
5. **Reconciliation.** The browser compares the server's state for the acked
   command with what it predicted for that command.
   - If they're identical, nothing happens.
   - If they're different, it jumps to the server's state and replays the
     commands the server hasn't seen yet. Small corrections are blended out
     over about 100 ms so you don't see a snap.
6. **Interpolation.** Other players are drawn 100 ms in the past
   (`INTERP_DELAY_MS` in `js/game.js`), blended between two snapshots. That
   keeps their movement smooth even when packets arrive unevenly.
7. **Lag compensation.** The server keeps 1 second of everyone's hitbox
   positions. Each usercmd says what time the shooter was seeing, so the server
   rewinds everyone else to that moment before checking the shot. You hit what
   you saw. It never rewinds more than 1 s, so lag can't be abused.
8. **Anti-cheat basics.** The server does all of these checks itself:
   - **Fire rate and ammo:** it simulates the weapon itself.
   - **Movement speed:** it runs the movement code.
   - **Speed-hacks:** a command budget stops a client sending more inputs than
     real time allows.
   - **Buying:** it checks buy zone, buy time, money and team restrictions.
   - **Lag compensation:** rewinding is clamped to 1 s.

## Files

### Top level

| File | What it does |
|---|---|
| `package.json` | Project info and the commands: `npm run dev`, `npm run deploy`, `npm test`, `npm run models`. |
| `wrangler.toml` | Cloudflare settings: the Worker, static files from `public/`, the `MATCH` Durable Object binding and its migration. |
| `README.md` | How to run, test, deploy and customise. |
| `docs/GUIDE.md` | This file. |

### `src/` — the Cloudflare server

| File | What it does |
|---|---|
| `worker.js` | Entry point. `/ws/<code>` goes to the lobby's Durable Object via `idFromName(code)`. Everything else is served from `public/`. |
| `match-do.js` | The **Durable Object** (one per lobby). Loads the map once from the static files, runs a `MatchServer` at 64 ticks/s, and accepts WebSockets with the hibernation API. The tick loop stops when the lobby is empty. |

### `public/shared/` — the game itself (browser **and** server)

| File | What it does |
|---|---|
| `constants.js` | Tick rate (64), movement values (`sv_accelerate`, `sv_friction`, ...), player size (72/54 tall, 32 wide, eyes 64/46), stamina, fall damage. |
| `usercmd.js` | The input format: button bits (`IN.FORWARD`, `IN.JUMP`...), view angles, weapon selection. |
| `glb.js` | A tiny .glb reader that pulls out triangles for physics (the server has no Three.js). |
| `mapLoader.js` | Turns the .glb into collision triangles in Hammer units. Applies `MAP_SCALE`, auto-detects which way is up, handles clip/nodraw meshes, skips tiny meshes, and prints the bounding box. |
| `collision.js` | Box and ray traces against the map triangles (Separating Axis Theorem + a grid). Keeps boxes 1/32 unit from walls like Source. |
| `movement.js` | **The movement code.** A port of Source's walk/air/step/slide logic, plus the CS2 additions (accelerate scale, air cap, bhop cap, stamina, crouch-jump, fall damage). |
| `weapons.js` | **Stats for every weapon.** Damage, armor penetration, RPM, magazine, reserve, reload, speed, price, kill reward, range, accuracy, spray patterns. Values marked TODO are estimates. |
| `weaponLogic.js` | What fire/reload/switch/scope/silencer/burst/knife/grenade-throw do each tick, plus the inventory. Shared, so prediction matches. |
| `hitboxes.js` | Body-part capsules (head, neck, chest, stomach, arms, legs) and ray tests. |
| `bullets.js` | Hitscan: map hits, wallbangs (penetration and damage loss), range falloff, hit groups, armor/helmet. |
| `random.js` | Seeded random numbers, so spread is the same on browser and server. |
| `grenades.js` | Grenade physics and effects: HE falloff, flash line of sight/facing, smoke flood fill, fire spread, decoy. |
| `items.js` | Weapons on the ground: drop (G), drop on death, pick up by walking over or with E. |
| `economy.js` | CS2 money rules and `tryBuy` (prices, team restrictions, armor/kit, grenade limits). |
| `rules.js` | **Bomb defusal**: warmup, freeze, live, planted and round end; win conditions, round money, halftime, first to 13. |
| `match.js` | **The authoritative game.** Players, commands, spawning, damage, kills, practice dummies, lag-compensation history and the 64-tick `step()`. |
| `server.js` | `MatchServer`: connections, decoding inputs, the fixed tick loop, and per-player snapshots and events. Used by both the Durable Object and Practice mode. |
| `protocol.js` | The binary message formats (inputs and snapshots), with delta compression for other players. |
| `bytes.js` | Helpers to read and write binary data. |

### `public/js/` — browser only

| File | What it does |
|---|---|
| `main.js` | Start-up: menu, loads the map, starts Practice or Online, auto-reconnect. |
| `game.js` | **The client loop.** Builds usercmds every tick, predicts, sends 2 per message, reconciles with snapshots, interpolates other players, measures ping. |
| `input.js` | Keyboard and mouse. Pointer lock with raw input, latched key taps, scroll-wheel jump, key bindings. |
| `net.js` | `WebSocketTransport` (online) and `LocalTransport` (Practice, with optional fake lag). |
| `settings.js` | Saved settings (sensitivity, crosshair, binds...) and the CS2 sensitivity formula. |
| `audio.js` | All sounds, generated in code with Web Audio and 3D-positioned for other players. |
| `presentation.js` | Turns events into effects: muzzle flash, tracers, bullet holes, blood, hit markers, scope, ammo HUD, dynamic crosshair. |
| `render/renderer.js` | Three.js setup: Z-up world in Hammer units, CS2 FOV, sky, lights, shadows; draws the map with the same orientation as physics. |
| `render/models.js` | Loads weapon and player models from `config/models.js`, fixes orientation and scale, and falls back to placeholders. |
| `render/viewmodel.js` | Your first-person gun: placement, bob, sway, recoil kick, reload/deploy/knife animations, muzzle flash. |
| `render/players.js` | Other players (blocky placeholders or your player models), walk/crouch/death animation, held weapon. |
| `render/effects.js` | Pooled tracers, bullet holes, puffs and muzzle flashes. |
| `render/nades.js` | Grenades in flight, explosions, smoke clouds, fire, flashbang white-out, dropped weapons. |
| `ui/hud.js` | Health, armor, money, ammo, net graph, debug overlay (F3). |
| `ui/crosshair.js` | Draws the CS2-style crosshair. |
| `ui/menus.js` | Settings and Controls screens (with key rebinding). |
| `ui/buymenu.js` | The B menu. |
| `ui/feed.js` | Kill feed, chat, money pop-ups, scoreboard (Tab). |
| `ui/round.js` | Round bar (scores, timer, players alive), round messages, plant/defuse progress, planted bomb and beeps, team menu (M). |
| `tools/modelCheck.js` | The `/model-check.html` page for previewing and placing weapon models. |

### `public/config/` — things you'll want to edit

| File | What it does |
|---|---|
| `map.js` | Map file, **`MAP_SCALE`**, up axis, clip/nodraw rules, **spawns**, **bombsites**, **buy zones**. All positions in Hammer units. |
| `models.js` | Which model each weapon and player uses, plus per-weapon orientation, scale and first-person placement. |

### Other folders

| Folder | What it holds |
|---|---|
| `public/maps/` | `de_dust2.glb` |
| `public/models/` | Optimized models plus `manifest.json`, made by `npm run models`. Don't edit by hand. |
| `source-models/` | Your original model files. Add new ones here. |
| `tools/optimize-models.mjs` | The `npm run models` script. |
| `tests/` | Automated tests (`npm test`): movement feel, weapons and CS2 damage numbers, grenades, rules and money, netcode (prediction, bundling, lag compensation). |

## Coordinate system

- Everything uses **Hammer units, Z up**, just like Hammer's status bar.
- Angles follow Source:
  - **yaw:** 0 = +X (east), 90 = +Y (north)
  - **pitch:** positive = looking down
- The renderer is set to Z-up, so physics positions are used directly.
