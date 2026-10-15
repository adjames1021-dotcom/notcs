// ---------------------------------------------------------------------------
// match-do.js — the Durable Object: ONE instance per lobby code. It is the
// authoritative game server for that lobby: it runs the same MatchServer
// code as Practice mode, at 64 ticks/s, and talks to players over WebSockets.
//
// Cost notes (Cloudflare bills incoming WebSocket messages at 20:1):
//   * clients send 2 ticks of input per message (32 msg/s per player)
//   * snapshots go OUT every tick (outgoing messages are free)
//   * when the last player leaves, the tick loop stops so the object can
//     go to sleep and stop billing
// ---------------------------------------------------------------------------

import { MatchServer } from '../public/shared/server.js';
import { CollisionWorld } from '../public/shared/collision.js';
import { loadMapGeometry } from '../public/shared/mapLoader.js';
import { MAP } from '../public/config/map.js';

// The parsed map is shared by every lobby running in the same isolate.
let worldPromise = null;
function loadWorld(env) {
  if (!worldPromise) {
    worldPromise = env.ASSETS.fetch(new Request('https://assets.local' + MAP.file))
      .then((res) => {
        if (!res.ok) throw new Error(`map ${MAP.file} not found (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        const geo = loadMapGeometry(buf, MAP);
        for (const line of geo.report) console.log(line);
        return new CollisionWorld(geo.triangles);
      })
      .catch((err) => {
        worldPromise = null;
        throw err;
      });
  }
  return worldPromise;
}

export class MatchRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.server = null;
    this.handlers = new Map(); // WebSocket -> MatchServer session handler
    // If we were evicted while sockets were open, the game state is gone:
    // tell those clients to reconnect (they keep their token).
    for (const ws of ctx.getWebSockets()) {
      try { ws.close(1012, 'server restarted'); } catch { /* already closed */ }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (!this.server) {
      const url = new URL(request.url);
      const mode = url.searchParams.get('mode') === 'dm' ? 'deathmatch' : 'defusal';
      const world = await loadWorld(this.env);
      if (!this.server) {
        this.server = new MatchServer({ world, map: MAP, mode, log: (m) => console.log('[match]', m) });
      }
    }
    const pair = new WebSocketPair();
    const [client, socket] = Object.values(pair);
    // Hibernation API: the runtime delivers messages to webSocketMessage().
    this.ctx.acceptWebSocket(socket);
    const conn = {
      send: (data) => socket.send(data),
      close: () => { try { socket.close(1000, 'closed by server'); } catch { /* ignore */ } },
    };
    this.handlers.set(socket, this.server.connect(conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const h = this.handlers.get(ws);
    if (h) h.onMessage(message);
  }

  webSocketClose(ws, code, reason) {
    this.dropSocket(ws);
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    this.dropSocket(ws);
  }

  dropSocket(ws) {
    const h = this.handlers.get(ws);
    this.handlers.delete(ws);
    if (h) h.onClose(); // stops the tick loop when nobody is left
  }
}
