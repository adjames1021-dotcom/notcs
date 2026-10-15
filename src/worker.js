// ---------------------------------------------------------------------------
// worker.js — the Cloudflare Worker (entry point on the server).
//
//   /ws/<lobby-code>  -> WebSocket to that lobby's Durable Object (stage 6)
//   everything else   -> static files from /public (the game itself)
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) {
      return new Response('Online play is added in stage 6', { status: 501 });
    }
    return env.ASSETS.fetch(request);
  },
};
