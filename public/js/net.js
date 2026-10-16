// ---------------------------------------------------------------------------
// net.js — how the browser talks to a game server.
//   WebSocketTransport: a real server (Cloudflare Durable Object).
//   LocalTransport:     Practice mode — the same server code running in this
//                       tab, with optional fake lag so you can test netcode.
// Both look the same to the game: send(data), onmessage, onclose.
// ---------------------------------------------------------------------------

export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.onmessage = null;
    this.onclose = null;
  }

  /** Opens a (new) connection. Can be called again to reconnect. */
  connect() {
    this.drop();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => { opened = true; resolve(); };
      ws.onerror = () => { if (!opened) reject(new Error('Could not connect to ' + this.url)); };
      ws.onmessage = (e) => { if (this.onmessage) this.onmessage(e.data); };
      ws.onclose = (e) => {
        if (!opened) { reject(new Error(`Could not connect (code ${e.code})`)); return; }
        if (this.ws === ws && this.onclose) this.onclose(e);
      };
      this.ws = ws;
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Closing on purpose: no onclose callback. */
  close() {
    this.drop();
  }

  drop() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(1000, 'bye'); } catch { /* ignore */ }
  }
}

export class LocalTransport {
  /** @param server a MatchServer running in this page */
  constructor(server, { lagMs = 0, jitterMs = 0 } = {}) {
    this.server = server;
    this.lagMs = lagMs;
    this.jitterMs = jitterMs;
    this.onmessage = null;
    this.onclose = null;
    this.session = null;
    this.closed = false;
    this.lastUp = 0;
    this.lastDown = 0;
  }

  delay(lastKey) {
    const oneWay = this.lagMs / 2 + Math.random() * this.jitterMs;
    // keep messages in order, like a real TCP/WebSocket connection
    const t = Math.max(performance.now() + oneWay, this[lastKey]);
    this[lastKey] = t;
    return t - performance.now();
  }

  connect() {
    const conn = {
      send: (data) => {
        if (this.closed) return;
        const d = this.delay('lastDown');
        const deliver = () => { if (!this.closed && this.onmessage) this.onmessage(data); };
        if (d <= 0) deliver(); else setTimeout(deliver, d);
      },
      close: () => this.close(),
    };
    this.session = this.server.connect(conn);
    return Promise.resolve();
  }

  send(data) {
    if (this.closed || !this.session) return;
    const d = this.delay('lastUp');
    const deliver = () => { if (!this.closed) this.session.onMessage(data); };
    if (d <= 0) deliver(); else setTimeout(deliver, d);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.session) this.session.onClose();
    if (this.onclose) this.onclose({ code: 1000 });
  }
}
