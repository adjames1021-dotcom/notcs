# notcs

A browser-based multiplayer first-person shooter inspired by Counter-Strike 2,
played on a fan-made de_dust2.

> ## ⚠ FREE FAN PROJECT — THIS WILL NEVER BE PAID FOR
> This game is 100% free and will **never** be sold. There will never be a price,
> paid items, skins, ads, subscriptions or donations. If anyone ever asks you to
> pay for it, it's a scam.
>
> Not affiliated with, endorsed by, or connected to Valve Corporation.
> Counter-Strike, CS2, de_dust2 and the weapon designs belong to Valve. The map
> and weapon models are fan-made recreations used non-commercially.

## Quick start

1. Install **Node.js 20 or newer** from https://nodejs.org (the "LTS" button).
2. Get the code. On GitHub: **Code → Download ZIP**, then unzip it. If you use
   git instead: `git clone https://github.com/adjames1021-dotcom/notcs`
3. Open a terminal in the `notcs` folder. On Windows, Shift + right-click the
   folder and choose "Open in Terminal".
4. Run these two commands:

   ```
   npm install
   npm run dev
   ```
5. Open **http://localhost:8787** in Chrome, Edge or Firefox. Click **Practice
   (offline)**.

Run `npm test` to run the automated tests (movement physics and netcode).

## Status

Built in stages:

- [x] **Stage 1:** loads the map at the right scale, with collision and
  CS-style ground movement.
- [x] **Stage 2:** jumping, crouching, walking, air strafing, landing slowdown
  and fall damage.
- [ ] Stage 3: weapons (AK-47, USP-S, knife) with target dummies.
- [ ] Stage 4: all CS2 weapons and grenades.
- [ ] Stage 5: HUD, crosshair, settings, buy menu and economy.
- [ ] Stage 6: online multiplayer on Cloudflare Durable Objects.
- [ ] Stage 7: bomb defusal rounds, teams and scoreboard.
- [ ] Stage 8: deploy to Cloudflare.
