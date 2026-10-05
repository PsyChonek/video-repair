// Minimal MP4 reading: top-level boxes of any file, and the codec settings of a
// healthy "reference" recording from the same camera. Phones, action cameras
// and many dashcams keep SPS/PPS only in the moov, so a broken file from them
// has no codec settings of its own; a good file from the same device does.

import { fourcc, u32be, u64be } from './bytes.ts';
import { detectCodec, type VideoCodec } from './codec.ts';
import type { Reader } from './reader.ts';

export interface TopBox {
  type: string;
  offset: number;
  headerSize: number;
  size: number;
}

/** Top-level boxes, trusting sizes only as far as the file actually goes. */
export async function topLevelBoxes(reader: Reader): Promise<TopBox[]> {
  const boxes: TopBox[] = [];
  let pos = 0;
  while (pos + 8 <= reader.size && boxes.length < 64) {
    const h = await reader.read(pos, 16);
    let size = u32be(h, 0);
    let headerSize = 8;
    if (size === 1) {
      size = u64be(h, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = reader.size - pos;
    }
    const type = fourcc(h, 4);
    if (size < headerSize || !/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push({ type, offset: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

interface Box {
  type: string;
  /** Start of the payload (after the 8-byte header). */
  body: number;
  end: number;
}

function children(buf: Uint8Array, start: number, end: number): Box[] {
  const list: Box[] = [];
  for (let pos = start; pos + 8 <= end; ) {
    const size = u32be(buf, pos);
    if (size < 8 || pos + size > end) break;
    list.push({ type: fourcc(buf, pos + 4), body: pos + 8, end: pos + size });
    pos += size;
  }
  return list;
}

const child = (buf: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined =>
  children(buf, parent.body + skip, parent.end).find((b) => b.type === type);

function path(buf: Uint8Array, parent: Box, types: string[]): Box | undefined {
  let box: Box | undefined = parent;
  for (const t of types) box = box && child(buf, box, t);
  return box;
}

export interface ReferenceAudio {
  sampleRate: number;
  channels: number;
  /** AAC AudioSpecificConfig. */
  asc: Uint8Array;
}

export interface ReferenceInfo {
  codec: VideoCodec;
  paramSets: Uint8Array[];
  width: number;
  height: number;
  /** Nominal frame timing from the first stts entry. */
  timing?: { timeScale: number; frameDuration: number };
  audio?: ReferenceAudio;
}

export class ReferenceError extends Error {}

/** Parameter sets stored in an avcC or hvcC record. */
function configParamSets(buf: Uint8Array, box: Box): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let pos = box.body;
  const take = () => {
    const len = (buf[pos]! << 8) | buf[pos + 1]!;
    nals.push(buf.slice(pos + 2, pos + 2 + len));
    pos += 2 + len;
  };
  if (box.type === 'avcC') {
    pos += 5;
    const sps = buf[pos++]! & 0x1f;
    for (let i = 0; i < sps; i++) take();
    const pps = buf[pos++]!;
    for (let i = 0; i < pps; i++) take();
  } else {
    pos += 22;
    const arrays = buf[pos++]!;
    for (let a = 0; a < arrays; a++) {
      pos++; // array_completeness + NAL type
      const count = (buf[pos]! << 8) | buf[pos + 1]!;
      pos += 2;
      for (let i = 0; i < count; i++) take();
    }
  }
  return nals;
}

/** DecoderSpecificInfo (tag 5) inside an esds box. */
function esdsConfig(buf: Uint8Array, box: Box): Uint8Array | null {
  for (let pos = box.body + 4; pos < box.end - 2; ) {
    const tag = buf[pos++]!;
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = buf[pos++]!;
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    if (tag === 5) return buf.slice(pos, pos + len);
    if (tag === 3) {
      // ES_ID + flags, optional fields, then nested descriptors.
      const flags = buf[pos + 2]!;
      pos += 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + buf[pos]!;
      if (flags & 0x20) pos += 2;
    } else if (tag === 4) pos += 13; // DecoderConfigDescriptor fields, then DSI
    else pos += len;
  }
  return null;
}

const VIDEO_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1']);

export async function readReference(reader: Reader): Promise<ReferenceInfo> {
  const moovBox = (await topLevelBoxes(reader)).find((b) => b.type === 'moov');
  if (!moovBox) throw new ReferenceError('Reference file has no moov box');
  if (moovBox.size > 64 << 20) throw new ReferenceError('Reference moov is unreasonably large');
  const buf = await reader.read(moovBox.offset, moovBox.size);
  const moov: Box = { type: 'moov', body: moovBox.headerSize, end: buf.length };

  let info: Omit<ReferenceInfo, 'codec'> & { codec?: VideoCodec } = { paramSets: [], width: 0, height: 0 };
  for (const trak of children(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(buf, trak, 'mdia');
    const hdlr = mdia && child(buf, mdia, 'hdlr');
    const mdhd = mdia && child(buf, mdia, 'mdhd');
    const stbl = mdia && path(buf, mdia, ['minf', 'stbl']);
    const stsd = stbl && child(buf, stbl, 'stsd');
    if (!hdlr || !mdhd || !stsd) continue;
    const handler = fourcc(buf, hdlr.body + 8);
    const entry = children(buf, stsd.body + 8, stsd.end)[0];
    if (!entry) continue;
    const timescale = u32be(buf, mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));

    if (handler === 'vide' && VIDEO_ENTRIES.has(entry.type) && !info.codec) {
      const config = children(buf, entry.body + 78, entry.end).find((b) => b.type === 'avcC' || b.type === 'hvcC');
      if (!config) continue;
      const paramSets = configParamSets(buf, config);
      const codec = detectCodec(paramSets);
      if (!codec) continue;
      const stts = child(buf, stbl!, 'stts');
      const delta = stts && u32be(buf, stts.body + 4) > 0 ? u32be(buf, stts.body + 12) : 0;
      info = {
        ...info,
        codec,
        paramSets,
        width: (buf[entry.body + 24]! << 8) | buf[entry.body + 25]!,
        height: (buf[entry.body + 26]! << 8) | buf[entry.body + 27]!,
        timing: timescale && delta ? { timeScale: timescale, frameDuration: delta } : undefined,
      };
    } else if (handler === 'soun' && entry.type === 'mp4a' && !info.audio) {
      const esds = children(buf, entry.body + 28, entry.end).find((b) => b.type === 'esds');
      const asc = esds && esdsConfig(buf, esds);
      if (!asc) continue;
      const channels = (buf[entry.body + 16]! << 8) | buf[entry.body + 17]!;
      info.audio = { sampleRate: timescale, channels, asc };
    }
  }
  if (!info.codec) throw new ReferenceError('Reference file has no H.264 or H.265 video track');
  return info as ReferenceInfo;
}
