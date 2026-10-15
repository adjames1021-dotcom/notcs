// ---------------------------------------------------------------------------
// audio.js — sound effects made in code with the Web Audio API (no sound
// files needed). Sounds from other players are positioned in 3D so you can
// hear where footsteps and shots come from, like in CS.
//
// Want real sounds later? Put .ogg/.mp3 files in /sounds/ and load them in
// playSample() — the rest of the game doesn't need to change.
// ---------------------------------------------------------------------------

export class Audio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }

  /** Browsers only allow audio after a click, so call this from one. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.settings.volume;
    this.master.connect(this.ctx.destination);
    // one second of white noise, reused by many effects
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v) {
    if (this.master) this.master.gain.value = v;
  }

  /** Move the "ears" to the camera. Hammer units are converted to ~meters. */
  setListener(pos, yaw) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const s = 1 / 40;
    const y = (yaw * Math.PI) / 180;
    // Web Audio is Y-up; map Hammer (x, y, z) -> (x, z, -y)
    const fx = Math.cos(y), fy = Math.sin(y);
    if (l.positionX) {
      l.positionX.value = pos[0] * s; l.positionY.value = pos[2] * s; l.positionZ.value = -pos[1] * s;
      l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = -fy;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos[0] * s, pos[2] * s, -pos[1] * s);
      l.setOrientation(fx, 0, -fy, 0, 1, 0);
    }
  }

  /** Output node: plain (your own sounds) or positioned in 3D (others). */
  out(pos) {
    if (!pos) return this.master;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.1;
    p.maxDistance = 80;
    const s = 1 / 40;
    if (p.positionX) { p.positionX.value = pos[0] * s; p.positionY.value = pos[2] * s; p.positionZ.value = -pos[1] * s; }
    else p.setPosition(pos[0] * s, pos[2] * s, -pos[1] * s);
    p.connect(this.master);
    return p;
  }

  noiseBurst({ pos = null, gain = 0.5, duration = 0.08, filter = 'bandpass', freq = 1000, q = 1, attack = 0.002, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = filter; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f); f.connect(g); g.connect(this.out(pos));
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  tone({ pos = null, gain = 0.3, freq = 440, freqEnd = null, duration = 0.1, type = 'sine', delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g); g.connect(this.out(pos));
    o.start(t); o.stop(t + duration + 0.02);
  }

  // ---- game sounds ---------------------------------------------------------------
  footstep(pos = null, loud = 1) {
    this.noiseBurst({ pos, gain: 0.35 * loud, duration: 0.07, filter: 'bandpass', freq: 380 + Math.random() * 180, q: 1.2 });
    this.noiseBurst({ pos, gain: 0.18 * loud, duration: 0.04, filter: 'highpass', freq: 2500, q: 0.7, delay: 0.01 });
  }

  land(pos = null, speed = 300) {
    const k = Math.min(1, speed / 600);
    this.noiseBurst({ pos, gain: 0.3 + 0.4 * k, duration: 0.12, filter: 'lowpass', freq: 500, q: 0.8 });
    this.tone({ pos, gain: 0.15 * k, freq: 90, freqEnd: 50, duration: 0.12 });
  }

  hurt() {
    this.noiseBurst({ gain: 0.4, duration: 0.15, filter: 'lowpass', freq: 700 });
  }
}
