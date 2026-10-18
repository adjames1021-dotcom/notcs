// ---------------------------------------------------------------------------
// match-do.js — the Durable Object: ONE instance per lobby code. It is the
// authoritative game server for that lobby: it runs the same MatchServer
// code as Practice mode, at 64 ticks/s, and talks to players over WebSockets.
//
// Staying inside Cloudflare's limits (the free plan allows 10 ms of CPU per
// request or incoming message):
//   * the map's collision is prebuilt (tools/build-map.mjs), so a new
//     lobby starts in ~3 ms instead of ~100 ms
//   * ticks run when players' input arrives (every message refreshes the CPU
//     allowance), with a timer only as a backup
//   * the normal WebSocket API is used, not the hibernation API: the 64-tick
//     loop keeps the object awake anyway, and this way one connection is one
//     invocation (and one log line) instead of one per incoming message
//
// Every lobby is public: it reports itself to the lobby directory
// (lobbies-do.js) so it shows up in the menu's lobby finder.
//
// Keeping the bill low:
//   * clients send 2 ticks of input per message (8 when dead), and Cloudflare
//     counts 20 incoming messages as 1 request; outgoing snapshots are free.
//     INPUT_TICKS_PER_MESSAGE in wrangler.toml changes the 2 (4 = half the
//     requests, for ~15 ms more input delay)
//   * players idle for 60 s (tab in the background) are disconnected
//   * when the last player leaves, the tick loop stops so the object can
//     shut down and stop billing
// ---------------------------------------------------------------------------

import { MatchServer } from '../public/shared/server.js';
import { CollisionWorld } from '../public/shared/collision.js';
import { loadMapGeometry } from '../public/shared/mapLoader.js';
import { MAP } from '../public/config/map.js';

const COLLISION_FILE = MAP.file.replace(/\.glb$/i, '.collision.bin');
const MODES = { comp: 'defusal', defusal: 'defusal', casual: 'casual', dm: 'deathmatch' };
const REPORT_EVERY_MS = 15000; // tell the lobby directory we're here

// The map is shared by every lobby running in the same isolate.
let worldPromise = null;
function loadWorld(env) {
  if (!worldPromise) {
    worldPromise = loadPrebuilt(env)
      .then((world) => world || parseGlb(env))
      .catch((err) => {
        worldPromise = null;
        throw err;
      });
  }
  return worldPromise;
}

async function fetchAsset(env, file) {
  return env.ASSETS.fetch(new Request('https://assets.local' + file));
}

async function loadPrebuilt(env) {
  const res = await fetchAsset(env, COLLISION_FILE);
  if (!res.ok) {
    console.log(`[map] ${COLLISION_FILE} missing (${res.status}); building collision from the .glb instead`);
    return null;
  }
  try {
    return CollisionWorld.deserialize(await res.arrayBuffer());
  } catch (err) {
    console.log(`[map] ${COLLISION_FILE} unusable (${err.message}); building collision from the .glb instead`);
    return null;
  }
}

async function parseGlb(env) {
  const res = await fetchAsset(env, MAP.file);
  if (!res.ok) throw new Error(`map ${MAP.file} not found (${res.status})`);
  const geo = loadMapGeometry(await res.arrayBuffer(), MAP);
  return new CollisionWorld(geo.triangles);
}

export class MatchRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.server = null;
    this.lobby = '';
    this.heartbeat = null;
    this.reportTimer = null;
  }

  /** Send our player count etc. to the lobby directory (lobbies-do.js). */
  report() {
    if (!this.env.LOBBIES || !this.server) return;
    const info = { code: this.lobby, ...this.server.summary() };
    const dir = this.env.LOBBIES.get(this.env.LOBBIES.idFromName('directory'));
    dir.fetch('https://lobbies/report', { method: 'POST', body: JSON.stringify(info) }).catch((err) => {
      console.log(`[${this.lobby}] lobby directory unreachable: ${err.message}`);
    });
  }

  /** Report soon (joins/leaves arrive in bursts). */
  reportSoon() {
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => { this.reportTimer = null; this.report(); }, 1500);
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.report(), REPORT_EVERY_MS);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    if (!this.server) {
      const mode = MODES[url.searchParams.get('mode')] || 'defusal';
      const world = await loadWorld(this.env);
      if (!this.server) {
        this.lobby = url.pathname.split('/').pop();
        this.server = new MatchServer({
          world, map: MAP, mode, timerSlackMs: 40, log: (m) => console.log(`[${this.lobby}] ${m}`),
          cmdsPerMessage: Number(this.env.INPUT_TICKS_PER_MESSAGE) || 2,
        });
        this.server.onEmpty = () => {
          // last player left: tell the directory, stop reporting, let the object sleep
          clearInterval(this.heartbeat); this.heartbeat = null;
          clearTimeout(this.reportTimer); this.reportTimer = null;
          this.report();
        };
        console.log(`[${this.lobby}] lobby started (${mode})`);
      }
    }
    const pair = new WebSocketPair();
    const [client, socket] = Object.values(pair);
    socket.accept();
    const conn = {
      send: (data) => socket.send(data),
      close: (code = 1000, reason = 'closed by server') => {
        try { socket.close(code, reason); } catch { /* already closed */ }
      },
    };
    const session = this.server.connect(conn);
    this.reportSoon();
    const opened = Date.now();
    let closed = false;
    socket.addEventListener('message', (e) => session.onMessage(e.data));
    socket.addEventListener('close', (e) => {
      if (closed) return;
      closed = true;
      console.log(`[${this.lobby}] socket closed by client: code ${e.code} ${e.reason || ''} after ${Math.round((Date.now() - opened) / 1000)} s`);
      session.onClose();
      if (this.server.match.connectedCount() > 0) this.reportSoon();
      try { socket.close(1000, 'bye'); } catch { /* already closed */ }
    });
    socket.addEventListener('error', (e) => {
      if (closed) return;
      closed = true;
      console.log(`[${this.lobby}] socket error: ${e.message || e.type}`);
      session.onClose();
      if (this.server.match.connectedCount() > 0) this.reportSoon();
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}
