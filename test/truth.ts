// Reads the real sample table of a healthy MP4 so tests can compare what the
// scanner recovers after the moov is stripped against what the muxer wrote.

import { fourcc, u32be } from '../src/core/bytes.ts';

export interface TruthSample {
  offset: number;
  size: number;
}

export interface Truth {
  video: TruthSample[];
  /** Presentation position of each video sample, indexed by decode order. */
  videoRank: number[];
  audio: TruthSample[];
  /** The same file with its moov removed, as a power cut would leave it. */
  broken: Uint8Array;
}

function boxes(buf: Uint8Array, start: number, end: number): { type: string; body: number; end: number }[] {
  const out = [];
  for (let p = start; p + 8 <= end; p += u32be(buf, p)) {
    if (u32be(buf, p) < 8) break;
    out.push({ type: fourcc(buf, p + 4), body: p + 8, end: p + u32be(buf, p) });
  }
  return out;
}

const find = (buf: Uint8Array, start: number, end: number, type: string) => boxes(buf, start, end).find((b) => b.type === type);

function samples(buf: Uint8Array, stbl: { body: number; end: number }): TruthSample[] {
  const stsz = find(buf, stbl.body, stbl.end, 'stsz')!;
  const stsc = find(buf, stbl.body, stbl.end, 'stsc')!;
  const stco = find(buf, stbl.body, stbl.end, 'stco')!;
  const count = u32be(buf, stsz.body + 8);
  const fixed = u32be(buf, stsz.body + 4);
  const sizes = Array.from({ length: count }, (_, i) => fixed || u32be(buf, stsz.body + 12 + i * 4));
  const chunks = Array.from({ length: u32be(buf, stco.body + 4) }, (_, i) => u32be(buf, stco.body + 8 + i * 4));
  const runs = Array.from({ length: u32be(buf, stsc.body + 4) }, (_, i) => ({
    first: u32be(buf, stsc.body + 8 + i * 12),
    perChunk: u32be(buf, stsc.body + 12 + i * 12),
  }));
  const out: TruthSample[] = [];
  chunks.forEach((chunkOffset, c) => {
    const run = runs.filter((r) => r.first <= c + 1).at(-1)!;
    let pos = chunkOffset;
    for (let k = 0; k < run.perChunk && out.length < count; k++) {
      const size = sizes[out.length]!;
      out.push({ offset: pos, size });
      pos += size;
    }
  });
  return out;
}

function presentationRank(buf: Uint8Array, stbl: { body: number; end: number }, count: number): number[] {
  const stts = find(buf, stbl.body, stbl.end, 'stts')!;
  const ctts = find(buf, stbl.body, stbl.end, 'ctts');
  const dts: number[] = [];
  let t = 0;
  for (let e = 0; e < u32be(buf, stts.body + 4); e++) {
    const [n, delta] = [u32be(buf, stts.body + 8 + e * 8), u32be(buf, stts.body + 12 + e * 8)];
    for (let k = 0; k < n; k++, t += delta) dts.push(t);
  }
  const offsets: number[] = [];
  for (let e = 0; ctts && e < u32be(buf, ctts.body + 4); e++) {
    const [n, off] = [u32be(buf, ctts.body + 8 + e * 8), u32be(buf, ctts.body + 12 + e * 8)];
    for (let k = 0; k < n; k++) offsets.push(off);
  }
  const pts = dts.slice(0, count).map((d, i) => d + (offsets[i] ?? 0));
  const order = pts.map((_, i) => i).sort((a, b) => pts[a]! - pts[b]!);
  const rank = new Array<number>(count);
  order.forEach((decodeIndex, presentIndex) => (rank[decodeIndex] = presentIndex));
  return rank;
}

export function readTruth(file: Uint8Array): Truth {
  const top = boxes(file, 0, file.length);
  const moov = top.find((b) => b.type === 'moov')!;
  const result: Truth = { video: [], videoRank: [], audio: [], broken: new Uint8Array() };
  for (const trak of boxes(file, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = find(file, trak.body, trak.end, 'mdia')!;
    const handler = fourcc(file, find(file, mdia.body, mdia.end, 'hdlr')!.body + 8);
    const minf = find(file, mdia.body, mdia.end, 'minf')!;
    const stbl = find(file, minf.body, minf.end, 'stbl')!;
    if (handler === 'vide') {
      result.video = samples(file, stbl);
      result.videoRank = presentationRank(file, stbl, result.video.length);
    }
    if (handler === 'soun') result.audio = samples(file, stbl);
  }
  // Drop the moov; it sits after the mdat in these fixtures, so offsets stay valid.
  const moovStart = moov.body - 8;
  if (moovStart < result.video[0]!.offset) throw new Error('Fixture must have its moov after the mdat');
  result.broken = file.slice(0, moovStart);
  return result;
}
