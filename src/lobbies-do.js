// ---------------------------------------------------------------------------
// lobbies-do.js — the lobby directory: ONE Durable Object that knows every
// open lobby, so the menu's lobby finder can list them.
//
// Every lobby (match-do.js) reports itself here when players join or leave
// and every 15 seconds while it's running. A lobby that stops reporting for
// 45 seconds (or reports 0 players) disappears from the list.
//
// The list only lives in memory: if this object restarts, the lobbies are
// back within 15 seconds. That keeps it free of storage costs.
// ---------------------------------------------------------------------------

const EXPIRE_MS = 45000;
const MODES = new Set(['defusal', 'casual', 'deathmatch']);

export class LobbyDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lobbies = new Map(); // code -> info
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/report') {
      let info;
      try { info = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
      const code = String(info.code || '');
      if (!/^[a-z0-9_-]{1,24}$/.test(code)) return new Response('bad code', { status: 400 });
      if (!(info.players > 0)) {
        this.lobbies.delete(code);
      } else {
        this.lobbies.set(code, {
          code,
          mode: MODES.has(info.mode) ? info.mode : 'defusal',
          map: String(info.map || 'de_dust2').slice(0, 32),
          players: Math.min(64, Math.floor(info.players)),
          max: Math.min(64, Math.floor(info.max) || 10),
          phase: String(info.phase || '').slice(0, 16),
          round: Math.floor(info.round) || 0,
          scoreT: Math.floor(info.scoreT) || 0,
          scoreCT: Math.floor(info.scoreCT) || 0,
          created: this.lobbies.get(code)?.created || Date.now(),
          updated: Date.now(),
        });
      }
      return new Response('ok');
    }
    if (url.pathname === '/list') {
      const now = Date.now();
      for (const [code, l] of this.lobbies) if (now - l.updated > EXPIRE_MS) this.lobbies.delete(code);
      const lobbies = [...this.lobbies.values()].sort((a, b) => b.players - a.players || a.created - b.created);
      return Response.json({ lobbies }, { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('not found', { status: 404 });
  }
}
