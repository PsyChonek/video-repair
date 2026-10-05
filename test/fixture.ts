// Builds a small file shaped like a truncated Novatek dashcam recording:
// ftyp, an mdat with a bogus size, 4-byte aligned video/audio items, nidx
// index boxes, an unindexed tail, and a cut-off final frame.

import { ByteWriter } from '../src/core/bytes.ts';

export const SPS = Uint8Array.from([
  0x67, 0x64, 0x00, 0x33, 0xac, 0x15, 0x4a, 0x02, 0x80, 0x0b, 0x5a, 0x6e, 0x02, 0x02, 0x02, 0x80, 0x00, 0x01, 0xf4, 0x00, 0x00,
  0x75, 0x30, 0x02,
]);
export const PPS = Uint8Array.from([0x68, 0xee, 0x3c, 0xb0]);

export interface FixtureItem {
  kind: 'video' | 'audio';
  offset: number;
  size: number;
  keyframe: boolean;
}

export interface Fixture {
  data: Uint8Array;
  indexed: FixtureItem[];
  tail: FixtureItem[];
}

const AUDIO_SLOT = 64;

export function buildFixture(options: { seconds?: number; tailFrames?: number } = {}): Fixture {
  const seconds = options.seconds ?? 3;
  const tailFrames = options.tailFrames ?? 3;
  const w = new ByteWriter();
  w.box('ftyp', (b) => b.str('mp42').u32(0).str('isomavc1mp42'));
  w.u32(0xe76e7a7b).str('mdat'); // size field left over from preallocation
  const align = () => w.zeros((4 - (w.length % 4)) % 4);
  let frame = 0;

  const writeVideo = (): FixtureItem => {
    align();
    const keyframe = frame % 15 === 0;
    const len = 300 + ((frame * 37) % 200);
    const offset = w.length;
    // Slice header as the real camera writes it: first_mb 0, I-slice, PPS 0.
    w.u32(len).u8(keyframe ? 0x65 : 0x21).u8(0x88).u8(0x80);
    for (let i = 3; i < len; i++) w.u8(((i * 7 + frame) & 0x7f) | 1);
    frame++;
    return { kind: 'video', offset, size: 4 + len, keyframe };
  };
  const writeAudio = (): FixtureItem => {
    align();
    const offset = w.length;
    w.u8(0x01).u8(0x4c).u8(0x35).u8(0xae);
    for (let i = 4; i < AUDIO_SLOT - 8; i++) w.u8(0x55);
    w.zeros(8); // AAC frame padded to the fixed slot size
    return { kind: 'audio', offset, size: AUDIO_SLOT, keyframe: false };
  };
  const writeNidx = (items: FixtureItem[]) => {
    align();
    const video = items.filter((i) => i.kind === 'video');
    const audio = items.filter((i) => i.kind === 'audio');
    const body = new ByteWriter();
    const le32 = (v: number) => body.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24);
    body.str('free').u32(0).str('nidx').u8(0x27).u8(0x64).u8(0x0e).u8(0x24).zeros(0x28 - 0x14);
    for (const v of [2560, 1440, 2, 30, 16000, 1, 0x40000, 0x316]) le32(v);
    for (const list of [video, audio]) {
      le32(list.length);
      for (const it of list) le32(it.offset), le32(0), le32(it.size), le32(it.keyframe ? 1 : 0);
    }
    const params = new ByteWriter().u32(1).bytes(SPS).u32(1).bytes(PPS).toBytes();
    le32(params.length);
    body.bytes(params);
    const bytes = body.toBytes();
    w.u32(bytes.length + 4).bytes(bytes);
  };

  const indexed: FixtureItem[] = [];
  for (let s = 0; s < seconds; s++) {
    const second: FixtureItem[] = [];
    for (let f = 0; f < 30; f++) {
      second.push(writeVideo());
      if (f % 2 === 1) second.push(writeAudio());
    }
    writeNidx(second);
    indexed.push(...second);
  }
  const tail: FixtureItem[] = [];
  for (let f = 0; f < tailFrames; f++) {
    tail.push(writeVideo());
    if (f % 2 === 1) tail.push(writeAudio());
  }
  // Power cut in the middle of a frame.
  align();
  w.u32(5000).u8(0x21).u8(0x88).zeros(100);
  return { data: w.toBytes(), indexed, tail };
}
