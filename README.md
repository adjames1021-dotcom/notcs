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
- **Real netcode:**
  - the server is in charge; your client predicts your own movement and
    shots, then corrects itself against the server
  - other players are shown 100 ms in the past, smoothly
  - lag compensation lets you hit what you see
  - automatic reconnect
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
| B | Buy menu |
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

There are **62 automated tests**. They check the numbers that make it feel like
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
| **5. HUD, buy menu, economy** | **Settings** has sensitivity, crosshair (dynamic or follow-recoil), volume and fake lag. The buy menu greys out the other team's guns. Money shows +$ after a kill. |
| **6. Multiplayer** | Two tabs, same lobby code, **Deathmatch**. In the second tab, press M to join the other team. Watch the other tab's player move smoothly; F3 shows ping and prediction corrections, which should stay near 0. Close one tab and reopen it: you get your player back. In Practice, set **Settings → Fake latency** to 150 ms; your own movement still responds instantly. |
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

**What it costs.** This project uses the free plan (Workers and SQLite-backed
Durable Objects). The free plan has daily usage limits; see
https://developers.cloudflare.com/durable-objects/platform/pricing/ for the
current numbers. If you go over, lobbies stop working until the next day; the
free plan doesn't bill you. The game is built to stay cheap:

- **Fewer incoming messages.** Each player sends 2 ticks of input per message,
  so 32 messages per second. Cloudflare counts 20 incoming WebSocket messages
  as 1 request.
- **Snapshots are free.** The server sends snapshots 64 times per second, and
  outgoing messages aren't billed.
- **Empty lobbies sleep.** When the last player leaves, the server stops its
  64-tick loop so the lobby can shut down.

**How a lobby works.** The Worker turns the lobby code into a Durable Object
with `idFromName(code)`, so the same code always reaches the same match.

## 4. Add or change models

Your models are in `source-models/weapons/`: AK-47, AUG, AWP, PP-Bizon, C4,
CZ75-Auto, Desert Eagle, Dual Berettas, G3SG1, Galil AR, both knives, M4A4,
MP5-SD, MP7, MP9, Negev and USP-S. Every other weapon shows a simple box gun
until you add its model.

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
