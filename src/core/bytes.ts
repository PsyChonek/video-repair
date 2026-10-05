// Byte helpers shared by the parsers and the MP4 writer.

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function fourcc(buf: Uint8Array, at: number): string {
  return String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!);
}

export function u32be(buf: Uint8Array, at: number): number {
  return ((buf[at]! << 24) >>> 0) + (buf[at + 1]! << 16) + (buf[at + 2]! << 8) + buf[at + 3]!;
}

export function u32le(buf: Uint8Array, at: number): number {
  return buf[at]! + (buf[at + 1]! << 8) + (buf[at + 2]! << 16) + ((buf[at + 3]! << 24) >>> 0);
}

/** Little-endian u64 as a JS number. Values above 2^53 are not expected in file offsets. */
export function u64le(buf: Uint8Array, at: number): number {
  return u32le(buf, at) + u32le(buf, at + 4) * 2 ** 32;
}

export function u64be(buf: Uint8Array, at: number): number {
  return u32be(buf, at) * 2 ** 32 + u32be(buf, at + 4);
}

/** Growable big-endian writer used to serialize MP4 boxes. */
export class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
    return this;
  }

  u24(v: number): this {
    return this.u8(v >>> 16).u16(v & 0xffff);
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
    return this;
  }

  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  str(s: string): this {
    return this.bytes(ascii(s));
  }

  /** Writes a box whose size is patched after `body` runs. */
  box(type: string, body: (w: this) => void): this {
    const start = this.length;
    this.u32(0).str(type);
    body(this);
    this.view.setUint32(start, this.length - start);
    return this;
  }

  /** Full box: version (8 bits) + flags (24 bits) after the header. */
  fullBox(type: string, version: number, flags: number, body: (w: this) => void): this {
    return this.box(type, (w) => {
      w.u8(version).u24(flags);
      body(w);
    });
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}
