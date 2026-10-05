// Bitstream helpers shared by the H.264 and H.265 parsers.

/** Splits an Annex B byte stream (00 00 01 / 00 00 00 01 start codes) into NAL units. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; payload: number }[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ at: i > 0 && data[i - 1] === 0 ? i - 1 : i, payload: i + 3 });
      i += 2;
    }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1]!.at : data.length;
    while (end > s.payload && data[end - 1] === 0) end--;
    return data.subarray(s.payload, end);
  });
}

/** Removes emulation prevention bytes (00 00 03) so the RBSP can be bit-parsed. */
export function toRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]!);
  }
  return Uint8Array.from(out);
}

export class BitReader {
  private pos = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new Error('Bitstream ended early');
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new Error('Bad Exp-Golomb code');
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  }
}
