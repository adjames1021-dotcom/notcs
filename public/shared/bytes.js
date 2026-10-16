// ---------------------------------------------------------------------------
// bytes.js — tiny helpers to write/read binary messages (much smaller and
// faster than JSON for things sent 64 times a second).
// ---------------------------------------------------------------------------

export class ByteWriter {
  constructor(initial = 256) {
    this.buf = new ArrayBuffer(initial);
    this.dv = new DataView(this.buf);
    this.o = 0;
  }
  ensure(n) {
    if (this.o + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.o + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = next;
    this.dv = new DataView(next);
  }
  u8(v) { this.ensure(1); this.dv.setUint8(this.o, v); this.o += 1; return this; }
  i8(v) { this.ensure(1); this.dv.setInt8(this.o, v); this.o += 1; return this; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.o, v, true); this.o += 2; return this; }
  i16(v) { this.ensure(2); this.dv.setInt16(this.o, v, true); this.o += 2; return this; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; return this; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.o, v | 0, true); this.o += 4; return this; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.o, v, true); this.o += 4; return this; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.o, v, true); this.o += 8; return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  str(s) {
    const bytes = new TextEncoder().encode(s);
    this.u16(bytes.length);
    this.ensure(bytes.length);
    new Uint8Array(this.buf, this.o, bytes.length).set(bytes);
    this.o += bytes.length;
    return this;
  }
  /** Patch a u8 written earlier (e.g. a count we didn't know yet). */
  setU8At(pos, v) { this.dv.setUint8(pos, v); }
  setU16At(pos, v) { this.dv.setUint16(pos, v, true); }
  finish() { return this.buf.slice(0, this.o); }
}

export class ByteReader {
  constructor(arrayBuffer) {
    this.dv = new DataView(arrayBuffer);
    this.o = 0;
  }
  get remaining() { return this.dv.byteLength - this.o; }
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8() { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  bool() { return this.u8() !== 0; }
  str() {
    const n = this.u16();
    const s = new TextDecoder().decode(new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.o, n));
    this.o += n;
    return s;
  }
}
