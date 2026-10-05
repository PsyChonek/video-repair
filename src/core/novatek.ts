// Novatek dashcam chipsets (Viofo, 70mai, Garmin, many no-name units) write a
// "free" box holding an "nidx" index roughly once per second while recording.
// Each one lists the offset and size of every video and audio frame written
// since the previous one, plus the SPS/PPS. When power is cut before the moov
// is written, these boxes still let us rebuild the sample tables exactly.

import { fourcc, u32be, u32le, u64le } from './bytes.ts';
import { splitAnnexB } from './h264.ts';
import type { Reader } from './reader.ts';
import type { Sample } from './types.ts';

export interface NidxInfo {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
}

export interface NidxBox {
  offset: number;
  info: NidxInfo;
  video: Sample[];
  audio: Sample[];
  /** SPS/PPS NAL units without start codes. */
  paramSets: Uint8Array[];
}

const ENTRY = 16;
const MAX_ENTRIES = 1000;
const MAX_BOX = 1 << 16;

export function parseNidx(box: Uint8Array, offset: number): NidxBox | null {
  if (box.length < 0x54 || fourcc(box, 4) !== 'free' || fourcc(box, 12) !== 'nidx') return null;
  const info: NidxInfo = {
    width: u32le(box, 0x28),
    height: u32le(box, 0x2c),
    fps: u32le(box, 0x34),
    sampleRate: u32le(box, 0x38),
    channels: u32le(box, 0x3c),
  };
  let pos = 0x48;
  const readEntries = (): Sample[] | null => {
    if (pos + 4 > box.length) return null;
    const count = u32le(box, pos);
    pos += 4;
    if (count > MAX_ENTRIES || pos + count * ENTRY > box.length) return null;
    const list: Sample[] = [];
    for (let i = 0; i < count; i++, pos += ENTRY) {
      list.push({ offset: u64le(box, pos), size: u32le(box, pos + 8) });
    }
    return list;
  };
  const video = readEntries();
  const audio = readEntries();
  if (!video || !audio) return null;
  let paramSets: Uint8Array[] = [];
  if (pos + 4 <= box.length) {
    const len = u32le(box, pos);
    if (len > 0 && pos + 4 + len <= box.length) paramSets = splitAnnexB(box.subarray(pos + 4, pos + 4 + len));
  }
  return { offset, info, video, audio, paramSets };
}

const BLOCK = 8 << 20;

/** Finds every nidx box in the file by scanning for the "free....nidx" signature. */
export async function findNidxBoxes(reader: Reader, onProgress?: (fraction: number) => void): Promise<NidxBox[]> {
  const boxes: NidxBox[] = [];
  const n = 0x6e; // 'n'
  for (let start = 0; start < reader.size; start += BLOCK) {
    // Overlap blocks by 16 bytes so a signature split across two reads is still found.
    const chunk = await reader.read(start, BLOCK + 16);
    for (let i = chunk.indexOf(n, 12); i !== -1 && i + 4 <= chunk.length; i = chunk.indexOf(n, i + 1)) {
      if (i >= BLOCK + 12) break;
      if (chunk[i + 1] !== 0x69 || chunk[i + 2] !== 0x64 || chunk[i + 3] !== 0x78) continue;
      if (fourcc(chunk, i - 8) !== 'free') continue;
      const boxOffset = start + i - 12;
      const size = u32be(chunk, i - 12);
      if (size < 0x54 || size > MAX_BOX) continue;
      const parsed = parseNidx(await reader.read(boxOffset, size), boxOffset);
      if (parsed) boxes.push(parsed);
    }
    onProgress?.(Math.min(1, (start + BLOCK) / reader.size));
  }
  return boxes;
}
