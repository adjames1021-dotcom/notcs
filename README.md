# notcs

A browser-based multiplayer first-person shooter inspired by Counter-Strike 2.
It's played on a fan-made de_dust2 and runs in Chrome, Edge or Firefox with
nothing to install for players.

> ## ⚠ FREE FAN PROJECT — THIS WILL NEVER BE PAID FOR
> This game is 100% free and will **never** be sold. There will never be a price,
> paid items, skins, ads, subscriptions or donations. If anyone ever asks you to
> pay for it, it's a scam.
>
> Not affiliated with, endorsed by, or connected to Valve Corporation.
> Counter-Strike, CS2, de_dust2 and the weapon designs belong to Valve. The map
> and weapon models are fan-made recreations used non-commercially. Don't sell
> this game or put it behind ads, because it uses Valve's designs.

The same warning appears on the start screen, the pause screen, the scoreboard
and at the bottom of the screen while you play.

---

## What's in it

- **CS2-style movement.** This is the Source engine movement code, not a
  generic FPS controller:
  - acceleration 5.5, friction 5.2, stop speed 80
  - air acceleration 12 with the 30-unit air cap, so air strafing works
  - counter-strafing
  - the 18-unit step-up, crouch-jumping, landing slowdown, and fall damage
- **Every CS2 weapon:**
  - 10 pistols, 7 SMGs, 6 heavy weapons, 7 rifles and 4 snipers
  - knives with backstabs, and the Zeus
  - fixed, learnable spray patterns
  - scopes, silencers, burst fire, the R8's hammer, and wallbangs
  - CS2 damage numbers, verified by tests; for example, an AK-47 headshot does
    111 through a helmet
- **Every grenade:**
  - **HE**
  - **Flashbang**, which checks line of sight and which way you face
  - **Smoke**, which flows around walls, blocks vision and puts out fire
  - **Molotov/incendiary**, with fire that spreads along the ground
  - **Decoy**
- **Bomb defusal:**
  - freeze time, buy time and the 1:55 round timer
  - plant in 3.2 s; defuse in 10 s, or 5 s with a kit
  - halftime side swap; first to 13 wins
- **The CS2 economy:** kill rewards per weapon, the loss bonus ladder, and plant
  and defuse rewards.
- **A CS2-style buy menu:**
  - five numbered columns (Pistols, Mid-Tier, Rifles, Equipment, Grenades)
  - pictures made from your weapon models
  - right-click refunds for anything unused you bought this round
  - a loadout you can change: pick which weapon sits in each slot
- **Real netcode:**
  - the server is in charge; your client predicts your own movement and
    shots, then corrects itself against the server
  - other players are shown 100 ms in the past, smoothly
  - lag compensation lets you hit what you see
  - if your connection drops, the game reconnects by itself in under a
    second, and your player waits for you for 10 seconds
- **Multiplayer:** each lobby runs on Cloudflare Workers with one Durable Object
  per lobby code.
- **Practice mode:** works offline against target dummies. It has an option to
  fake lag so you can test the netcode.

## 1. Play it on your own computer

You need **Node.js 20 or newer**. Get it from https://nodejs.org (press the
**LTS** button and install it).

1. **Get the code.** On the GitHub page, click **Code → Download ZIP** and unzip
   it. If you use git: `git clone https://github.com/adjames1021-dotcom/notcs`
2. **Open a terminal in the folder.**
   - **Windows:** open the `notcs` folder, click the address bar, type `cmd` and
     press Enter.
   - **Mac:** right-click the folder and choose *New Terminal at Folder*.
3. **Install the tools.** You only do this once:
   ```
   npm install
   ```
4. **Start the game server:**
   ```
   npm run dev
   ```
   Leave this window open. It prints `Ready on http://localhost:8787`.
5. **Play.** Open **http://localhost:8787** in Chrome or Edge.
   - **Practice (offline):** you, the map and target dummies.
   - **Play online:** type a lobby code. Open a second browser tab with the same
     code to play against yourself.

**Friends on the same Wi-Fi.** Start the server with `npm run lan` instead of
`npm run dev`. Find your computer's IP address:
- **Windows:** run `ipconfig` and look for *IPv4 Address*.
- **Mac:** System Settings → Wi-Fi → Details.

Friends then open `http://YOUR-IP:8787`, for example `http://192.168.1.20:8787`.
If Windows asks about the firewall, click **Allow**.

Press **Ctrl + C** in the terminal to stop the server.

### Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Mouse | Look (CS2 formula: your CS2 sensitivity works the same) |
| Left / right mouse | Shoot / scope, silencer, burst mode, knife stab |
| Space | Jump |
| Ctrl or C | Crouch |
| Shift | Walk (silent) |
| R | Reload |
| 1 2 3 4 5 | Primary, pistol, knife/Zeus, grenades (press again to cycle), bomb |
| Q | Last weapon |
| Mouse wheel | Next/previous weapon (or jump: see Settings) |
| G | Drop weapon |
| E | Pick up a weapon you're looking at / plant / defuse |
| B | Buy menu: click, or press the column number then the item number (B 3 2 = 2nd rifle). Right-click an item you bought this round to refund it. |
| Tab | Scoreboard |
| M | Choose team |
| Y / U | Chat / team chat |
| F3 | Debug overlay (position, speed, tick, ping, prediction errors) |
| Esc | Release the mouse |

Grenades work like CS2:
- **Left click** throws far.
- **Right click** is an underhand throw.
- **Both buttons** give a medium throw.

You can change every key in **Controls**.

## 2. Test each stage

There are **70 automated tests**. They check the numbers that make it feel like
CS: speeds, jump height, fall damage, damage values, fire rates, money and
prediction. Run them with:

```
npm test
```

Then check each stage by hand:

| Stage | How to check it |
|---|---|
| **1. Map and movement** | Click **Practice**. Open the browser console (F12): the map prints its size (≈ 4480 × 5312 units) and the detected up axis. Press **F3** and run: speed tops out at **250** with the knife (press 3) and **215** with the AK. Slide along walls, run up stairs (18-unit steps) and slopes. |
| **2. Jump, crouch, air strafe** | Jumps reach ~55 units. Crouch-jump (Space, then Ctrl in the air) gets you onto the tall crates. In the air, hold A or D and turn the mouse the same way to gain speed past 250. Jumping as you land (bhop) caps you at 275. Shift walks silently. Big drops hurt. |
| **3. Weapons** | Spray the AK at the dummies: the pattern is the same every time. Tap the USP-S. Knife a dummy from behind (right click) for a one-hit backstab. The helmet dummy dies to one AK headshot (111 damage). |
| **4. All guns and grenades** | Press **B** (free in Practice) and try everything. Grenades: the smoke blocks vision and puts out the molotov, the flash whites you out, and the HE blows a hole in smoke. Drop guns with G and pick them up again. |
| **5. HUD, buy menu, economy** | **Settings** has sensitivity, crosshair (dynamic or follow-recoil), volume and fake lag. Press **B**: the CS2-style menu shows your money and buy time. Buy something, then right-click it to get the money back. Click **LOADOUT** to change which guns are in your menu. Money shows +$ after a kill. |
| **6. Multiplayer** | Two tabs (or two windows side by side), same lobby code, **Deathmatch**. Deathmatch is free-for-all like CS2, so you can shoot each other whichever team you're on. Watch the other tab's player move smoothly. F3 shows ping, prediction corrections (which should stay near 0) and reconnects. Close one tab and reopen it: you get your player back. In Practice, set **Settings → Fake latency** to 150 ms; your own movement still responds instantly. |
| **7. Bomb defusal** | Two tabs, same lobby code, **Bomb defusal**, one player per team. Warmup, then round 1 with freeze time. The T has the C4 (key 5): plant at A or B by holding left click, and the CT defuses by holding **E**. |

## 3. Put it online (Cloudflare) — free

1. Make a free account at https://dash.cloudflare.com/sign-up
2. In the `notcs` folder, run:
   ```
   npx wrangler login
   ```
   A browser window opens. Click **Allow**.
3. Deploy:
   ```
   npm run deploy
   ```
   At the end it prints your game's address, something like
   `https://notcs.<your-name>.workers.dev`.
4. Send that link to your friends. Everyone types the **same lobby code** and
   clicks **Play online**.

To update the online version later, run `npm run deploy` again.

**What it costs.** The game runs on Cloudflare's **free plan** (Workers and
SQLite-backed Durable Objects). The free plan never bills you. If you use up a
daily allowance, lobbies stop working until it resets at midnight UTC. Check
https://developers.cloudflare.com/durable-objects/platform/pricing/ for the
current numbers. At the time of writing:

| Free daily allowance | What uses it | Roughly how much play that is |
|---|---|---|
| 100,000 requests | Players' input: 20 incoming messages count as 1 request. A living player sends 32 messages a second, about 5,800 requests an hour. | About 17 player-hours a day, e.g. 4 friends for 4 hours |
| 13,000 GB-seconds | Each lobby with someone in it | About 29 lobby-hours a day |

The game keeps these low:

- **Fewer messages.** Living players send 2 ticks of input per message. Dead
  players and spectators send 8.
- **Snapshots are free.** The server sends snapshots 64 times per second, and
  Cloudflare doesn't bill outgoing messages.
- **Idle players are disconnected.** A tab left in the background for 60
  seconds is disconnected, so a forgotten tab can't keep a lobby running all
  day. The game rejoins by itself when you come back.
- **Empty lobbies sleep.** When the last player leaves, the 64-tick loop
  stops and the lobby shuts down.

**If you run out of free requests,** open `wrangler.toml` and change
`INPUT_TICKS_PER_MESSAGE = "2"` to `"4"`, then deploy again. That halves the
requests and adds about 15 ms of input delay; your own movement still responds
instantly.

On the **Workers Paid plan** ($5 a month), 10 players for an hour costs about
a cent.

The game is still free for players either way. The "never paid for" promise
means nobody is ever charged to play. Hosting costs, if any, are yours.

**Seeing what the server is doing.** In the Cloudflare dashboard, open
**Workers & Pages → notcs → Logs**. Each lobby start, connection and
disconnection is one line, with the close code.

**How a lobby works.** The Worker turns the lobby code into a Durable Object
with `idFromName(code)`, so the same code always reaches the same match.

## 4. Add or change models

All 19 models you uploaded are in the game, in `source-models/weapons/`:
AK-47, AUG, AWP, PP-Bizon, C4, CZ75-Auto, Desert Eagle, Dual Berettas, G3SG1,
Galil AR, Glock-18, both knives, M4A4, MP5-SD, MP7, MP9, Negev and USP-S.

These have **no model yet**. In game they show a simple box gun, and in the buy
menu a white outline:

- **Pistols:** P2000, P250, Five-SeveN, Tec-9, R8 Revolver
- **SMGs:** MAC-10, UMP-45, P90
- **Shotguns:** Nova, XM1014, Sawed-Off, MAG-7
- **Rifles and snipers:** M249, FAMAS, M4A1-S, SG 553, SSG 08, SCAR-20
- **Other:** Zeus x27 and all six grenades
- **Players:** the T and CT player models

If a new model comes out huge, tiny or pointing the wrong way, set `scale`,
`forward` and `up` for it in `public/config/models.js`. The Glock needed
`forward: '-x'` and `scale: 8.7` because it was exported lying sideways and
exactly 1 unit long.

1. Name the file after the weapon's id and put it in `source-models/weapons/`.
   For example, `m4a1s.glb` or `glock.glb`. The list of ids is in
   `public/config/models.js`.
2. Run:
   ```
   npm run models
   ```
   This makes a small, fast copy in `public/models/weapons/`. Your 87 MB of
   models became 11 MB, with no visible difference.
3. Open **http://localhost:8787/model-check.html**. Pick the weapon and check it
   looks right in first person. Use the sliders to adjust it, then copy the line
   it prints into `public/config/models.js`.
4. If the gun points the wrong way, set `forward` and `up` for it in
   `public/config/models.js`.

**Player models** work the same way. Put `t.glb` and `ct.glb` in
`source-models/players/` and run `npm run models`. They're scaled to 72 units
tall automatically. Use a standing pose, not a T-pose.

GitHub won't take any single file over 100 MB, and the web upload limit is
25 MB. The originals here are 2–7 MB each, so they're fine.

## 5. Change spawns, bombsites, map scale

All of it is in **`public/config/map.js`**, in Hammer units. Press **F3** in game
to see your position, then copy the numbers.

- `MAP_SCALE`: multiplies the .glb's units to get Hammer units. This map is
  already in Hammer units, so it's 1. A map exported in meters needs 39.37.
- `UP_AXIS`: set it if a map loads sideways. Normally `'auto'` works it out.
- `spawns`, `bombsites`, `buyzones`: change these freely.

## 6. Tuning

Values I wasn't sure of are marked `// TODO` in the code.

- **Accuracy and recoil:** `public/shared/weapons.js` has the inaccuracy numbers
  and the spray patterns.
- **Movement:** `public/shared/constants.js` has the stamina/landing penalty, the
  crouch speed and tagging.
- **Grenades:** `public/shared/grenades.js` has the flash durations, smoke size
  and molotov damage.
- **Rounds:** `RULES` at the top of `public/shared/rules.js` has the round
  timings.

Run `npm test` after changing things. Some tests check CS2 numbers on purpose,
so a failing test tells you what changed.

## 7. How it fits together

`docs/GUIDE.md` explains every file: what it does, where it goes, and how the
netcode works. The short version:

```
public/            everything the browser downloads (served by Cloudflare)
  index.html       the page
  js/              browser-only code: rendering, input, HUD, menus, sounds
  shared/          the game itself, used by BOTH the browser and the server
                   (movement, weapons, collision, rules) so physics is identical
  config/          map.js (spawns, bombsites, scale) and models.js (model files)
  maps/            de_dust2.glb
  models/          optimized weapon/player models (made by `npm run models`)
src/               the Cloudflare server: worker.js (routing) + match-do.js (lobby)
source-models/     your original model files
tests/             automated tests (`npm test`)
tools/             the model optimizer
wrangler.toml      Cloudflare settings
```

## Troubleshooting

- **Ctrl + W closed my tab!** Browsers use Ctrl+W to close tabs. The game asks
  you to confirm before leaving, and in fullscreen Chrome lets it capture the
  shortcut. You can also crouch with **C**, or rebind crouch in Controls.
- **The mouse won't lock.** Click inside the game once. Press Esc to get the
  mouse back.
- **Black screen or very slow.** Turn off **Shadows** and lower **Render scale**
  in Settings, then reload the page.
- **`npm run dev` says the port is in use.** Another copy is already running.
  Close it, or run `npx wrangler dev --port 8788`.
- **Bomb defusal never starts.** It needs at least one player on each team.
  Press M to pick a team, or use Deathmatch to play alone.
- **"Connection lost — reconnecting…" at the top of the screen.** The game
  reconnects by itself, usually in under a second, and your player waits for
  you for 10 seconds. If it keeps happening:
  - Press **F3**. The last line shows how many times you've reconnected and the
    close code.
  - Check the Cloudflare logs (see *Seeing what the server is doing* above).
  - **Exceeded CPU** or **Exceeded resources** means a lobby went over the free
    plan's CPU limit.
  - **Daily request limit** means you used up the free requests for today; see
    *If you run out of free requests*.
- **New files don't show up in `npm run dev`.** Stop it with Ctrl + C and
  start it again; wrangler only notices changes to files it already knew
  about.
