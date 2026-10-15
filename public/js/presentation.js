// ---------------------------------------------------------------------------
// presentation.js — turns game events into things you see and hear:
// viewmodel animation, muzzle flash, tracers, bullet holes, blood, sounds,
// hit markers, scope view, ammo HUD. (Pure visuals: no gameplay here.)
// ---------------------------------------------------------------------------

import { Viewmodel } from './render/viewmodel.js';
import { Effects } from './render/effects.js';
import { WEAPONS, weaponByIndex, RECOIL_SCALE, VIEW_TRACKING } from '../shared/weapons.js';
import { activeWeapon, activeAmmo, SLOT, FLAG, slotWeapon } from '../shared/weaponLogic.js';
import { traceBullet } from '../shared/bullets.js';
import { rayPlayer } from '../shared/hitboxes.js';
import { EFLAG } from '../shared/protocol.js';

const $ = (id) => document.getElementById(id);

export class Presentation {
  constructor(game, renderer, models) {
    this.game = game;
    this.renderer = renderer;
    this.models = models;
    this.viewmodel = new Viewmodel(renderer, models);
    this.effects = new Effects(renderer);
    this.hitmarkerT = 0;
    this.hurtT = 0;
    this.lastMouse = [0, 0];
    this.scopeEl = $('scope-overlay');
    this.hitEl = $('hitmarker');
    this.hurtEl = $('hurt-flash');
    this._caps = [];

    game.onPredictedWeapon = (out, ps, ws) => this.onPredictedWeapon(out, ps, ws);
    game.on('event', (ev) => this.onEvent(ev));
    game.beforeRender = (alpha, dt) => this.beforeRender(alpha, dt);
    game.updateHud = (hud) => this.updateHud(hud);
    game.viewPunch = () => [game.ws.punchP * RECOIL_SCALE * VIEW_TRACKING, game.ws.punchY * RECOIL_SCALE * VIEW_TRACKING];
    game.on('predicted', (ev) => { if (ev.landSpeed > 200) this.viewmodel.onLand(ev.landSpeed); });
  }

  /** Your own shots: show effects immediately (client-side prediction). */
  onPredictedWeapon(out, ps, ws) {
    const g = this.game;
    for (const shot of out.shots) {
      const def = WEAPONS[shot.weapon];
      this.viewmodel.onShot(def);
      g.audio.gunshot(def, null, shot.silenced);
      // where would the bullets go? (world + other players as we see them)
      const test = this.remotePlayerTester();
      for (const dir of shot.dirs) {
        const res = traceBullet(g.world, shot.origin, dir, def, test, g.localId);
        const muzzle = [shot.origin[0] + dir[0] * 30 - dir[1] * 6, shot.origin[1] + dir[1] * 30 + dir[0] * 6, shot.origin[2] - 5];
        if (def.cls !== 'shotgun' || Math.random() < 0.4) this.effects.tracer(muzzle, res.end);
        for (const im of res.impacts) this.effects.impact(im.pos, im.normal);
      }
      if (!shot.silenced) this.effects.light.position.set(shot.origin[0], shot.origin[1], shot.origin[2]);
    }
    if (out.knife) { this.viewmodel.onKnife(out.knife.kind); g.audio.knife(false); }
    if (out.reloadStart) g.audio.reload(activeWeapon(ws));
    if (out.emptyClick) g.audio.emptyClick();
    if (out.zoomChanged) g.audio.zoom();
    void ps;
  }

  remotePlayerTester() {
    const g = this.game;
    return (start, dir, maxDist, exclude) => {
      let best = null;
      for (const [id, ent] of g.entities) {
        const s = ent.render || ent.latest;
        if (!s || !(s.flags & EFLAG.ALIVE) || (exclude && exclude.has(id))) continue;
        const h = rayPlayer(start, dir, maxDist, s.pos, s.yaw, s.duck, this._caps);
        if (h && (!best || h.t < best.t)) best = { t: h.t, group: h.group, id };
      }
      return best;
    };
  }

  /** Events from the server (other players shooting, hits, kills...). */
  onEvent(ev) {
    const g = this.game;
    switch (ev.type) {
      case 'shot': {
        const def = WEAPONS[ev.weapon];
        if (!def) break;
        const ent = g.entities.get(ev.id);
        const s = ent && (ent.render || ent.latest);
        const pos = s ? [s.pos[0], s.pos[1], s.pos[2] + 50] : ev.origin;
        g.audio.gunshot(def, pos, ev.silenced);
        const muzzle = s ? muzzleOf(s) : ev.origin;
        if (!ev.silenced) this.effects.muzzleFlash(muzzle);
        ev.ends.forEach((end, i) => { if (def.cls !== 'shotgun' || i % 3 === 0) this.effects.tracer(muzzle, end); });
        for (const im of ev.impacts) this.effects.impact([im[0], im[1], im[2]], [im[3], im[4], im[5]]);
        break;
      }
      case 'blood':
        this.effects.impact(ev.pos, [-ev.dir[0], -ev.dir[1], -ev.dir[2]], true);
        break;
      case 'hit':
        this.hitmarkerT = 0.25;
        this.hitHead = ev.group === 1;
        g.audio.hitmarker(ev.group === 1, ev.kill);
        break;
      case 'damage':
        if (ev.id === g.localId) { this.hurtT = Math.min(1, 0.4 + ev.amount / 60); }
        break;
      case 'knife':
        g.audio.knife(!!ev.hitPlayer, g.entities.get(ev.id)?.latest?.pos);
        break;
      case 'reload': {
        const ent = g.entities.get(ev.id);
        if (ent) g.audio.reload(weaponByIndex(ent.latest.weapon), ent.latest.pos);
        break;
      }
      default:
        break;
    }
  }

  beforeRender(alpha, dt) {
    const g = this.game;
    const ws = g.ws;
    const def = g.alive ? activeWeapon(ws) : null;
    this.viewmodel.setWeapon(def);
    // scope
    const scoped = !!(def && def.scope && ws.zoom > 0);
    g.scoped = scoped && def.cls === 'sniper';
    if (scoped) {
      const fov = def.scope.fov[ws.zoom - 1];
      this.renderer.setFovScale(Math.tan((fov * Math.PI) / 360));
      g.input.zoomFovRatio = fov / 90; // TODO: CS2 zoom_sensitivity_ratio formula
    } else {
      this.renderer.setFovScale(1);
      g.input.zoomFovRatio = 1;
    }
    if (this.scopeEl) this.scopeEl.classList.toggle('hidden', !scoped);
    if (this.scopeEl) this.scopeEl.classList.toggle('thin', scoped && def.cls !== 'sniper');
    // animation inputs
    const t = ws.time;
    const deploy = def ? Math.min(1, 1 - (ws.deployEnd - t) / (def.deploy || 1)) : 1;
    let reload = -1;
    if (def && ws.reloadEnd > 0) reload = 1 - (ws.reloadEnd - t) / def.reload;
    else if (def && ws.shellState > 0) reload = 0.5;
    const speed = Math.hypot(g.pred.vel[0], g.pred.vel[1]);
    const mdx = g.input.yaw - this.lastMouse[0], mdy = g.input.pitch - this.lastMouse[1];
    this.lastMouse = [g.input.yaw, g.input.pitch];
    const ammo = activeAmmo(ws);
    this.viewmodel.update({
      dt, speed, onGround: g.pred.onGround, mouseDX: Math.max(-20, Math.min(20, -mdx)), mouseDY: Math.max(-20, Math.min(20, mdy)),
      deploy, reload, scoped: scoped && def.cls === 'sniper', silenced: !!(def && def.silencer && (ammo.flags & FLAG.SILENCER_ON)),
    });
    this.effects.update(dt);
    // hit marker + damage flash
    this.hitmarkerT = Math.max(0, this.hitmarkerT - dt);
    this.hurtT = Math.max(0, this.hurtT - dt * 1.5);
    if (this.hitEl) { this.hitEl.style.opacity = String(Math.min(1, this.hitmarkerT * 5)); this.hitEl.classList.toggle('head', !!this.hitHead); }
    if (this.hurtEl) this.hurtEl.style.opacity = String(this.hurtT * 0.6);
    void alpha;
  }

  updateHud(hud) {
    const g = this.game;
    const ws = g.ws;
    const def = activeWeapon(ws);
    const ammo = activeAmmo(ws);
    if (def && def.gun) {
      hud.set('ammo', hud.el.ammo, def.id === 'zeus' ? String(ammo.clip) : String(ammo.clip));
      hud.set('reserve', hud.el.reserve, def.id === 'zeus' ? '' : ' / ' + ammo.reserve);
    } else {
      hud.set('ammo', hud.el.ammo, def ? (def.cls === 'grenade' ? '●' : '') : '');
      hud.set('reserve', hud.el.reserve, '');
    }
    // weapon list (right side)
    const parts = [];
    const add = (slot, label) => { const w = slotWeapon(ws, slot); if (w) parts.push(`${slot === ws.active ? '▶ ' : ''}${label} ${w.name}`); };
    add(SLOT.PRIMARY, '1');
    add(SLOT.SECONDARY, '2');
    add(SLOT.KNIFE, '3');
    add(SLOT.ZEUS, '3');
    const nades = [SLOT.HE, SLOT.FLASH, SLOT.SMOKE, SLOT.FIRE, SLOT.DECOY].filter((s) => slotWeapon(ws, s));
    if (nades.length) parts.push(`${nades.includes(ws.active) ? '▶ ' : ''}4 ${nades.map((s) => slotWeapon(ws, s).name.replace(' Grenade', '')).join(', ')}${ws.flash > 1 ? ' x2' : ''}`);
    add(SLOT.C4, '5');
    hud.set('weapons', hud.el.weapons, parts.join('\n'));
  }
}

/** Approximate muzzle position for another player's gun. */
function muzzleOf(s) {
  const y = (s.yaw * Math.PI) / 180;
  const z = s.pos[2] + 54 - 16 * s.duck;
  return [s.pos[0] + Math.cos(y) * 30 + Math.sin(y) * 6, s.pos[1] + Math.sin(y) * 30 - Math.cos(y) * 6, z];
}
