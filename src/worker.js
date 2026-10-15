// ---------------------------------------------------------------------------
// worker.js — the Cloudflare Worker (the entry point on the server).
//
//   /ws/<lobby-code>  -> WebSocket to that lobby's Durable Object.
//                        idFromName(lobbyCode) means everyone who types the
//                        same code lands in the same match.
//   everything else   -> the game's static files from /public
// ---------------------------------------------------------------------------

export { MatchRoom } from './match-do.js';

const LOBBY = /^\/ws\/([a-z0-9_-]{1,24})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = LOBBY.exec(url.pathname);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const id = env.MATCH.idFromName(m[1]);
      return env.MATCH.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/ws/')) return new Response('Bad lobby code', { status: 400 });
    return env.ASSETS.fetch(request);
  },
};
