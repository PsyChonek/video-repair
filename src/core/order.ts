// Presentation order for streams with B-frames. Samples are stored in decode
// order; each picture's POC says where it is shown. Without a ctts box,
// players would show B-frames out of order.

import { u32be } from './bytes.ts';
import type { VideoCodec } from './codec.ts';
import type { Reader } from './reader.ts';
import type { VideoSample } from './types.ts';

const SLICE_HEADER_BYTES = 48;

/** The NAL header bytes and the start of the first slice in a sample. */
async function firstSlice(reader: Reader, codec: VideoCodec, sample: VideoSample): Promise<Uint8Array | null> {
  const end = sample.offset + sample.size;
  for (let pos = sample.offset; pos + 6 <= end; ) {
    const h = await reader.read(pos, 4 + codec.headerBytes + SLICE_HEADER_BYTES);
    const len = u32be(h, 0);
    if (len < 2) return null;
    if (codec.isSlice(codec.nalType(h[4]!))) return h.subarray(4);
    pos += 4 + len;
  }
  return null;
}

export interface Composition {
  offsets: number[];
  delay: number;
}

/** Composition offsets in frames, or null when every frame is shown in decode order. */
export async function compositionOffsets(
  reader: Reader,
  codec: VideoCodec,
  paramSets: Uint8Array[],
  samples: VideoSample[],
): Promise<Composition | null> {
  const order = codec.pictureOrder(paramSets);
  if (!order) return null;
  const keys: number[] = [];
  for (const sample of samples) {
    const slice = await firstSlice(reader, codec, sample);
    const key = slice && order(slice[0]!, slice[1]!, slice.subarray(codec.headerBytes));
    if (key === null || key === undefined) return null;
    keys.push(key);
  }
  const byPresentation = keys.map((_, i) => i).sort((a, b) => keys[a]! - keys[b]! || a - b);
  const rank = new Array<number>(samples.length);
  byPresentation.forEach((decodeIndex, presentIndex) => (rank[decodeIndex] = presentIndex));
  const raw = rank.map((r, i) => r - i);
  if (raw.every((d) => d === 0)) return null;
  const delay = raw.reduce((max, d) => Math.max(max, -d), 0);
  return { offsets: raw.map((d) => d + delay), delay };
}
