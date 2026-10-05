import { fourcc, u32be, u64be } from './bytes.ts';
import { buildAvcC, NAL_IDR, NAL_PPS, NAL_SLICE, NAL_SPS, nalType, parseSps, splitAnnexB } from './h264.ts';
import { buildMp4Header } from './mp4.ts';
import { findNidxBoxes, type NidxBox } from './novatek.ts';
import type { Reader } from './reader.ts';
import { RawScanner, type StreamModel } from './scan.ts';
import { scanVideoOnly } from './videoscan.ts';
import type { AudioTrack, Sample, VideoSample, VideoTrack } from './types.ts';

export type WarningCode =
  | 'file-has-moov'
  | 'no-index-video-only'
  | 'dropped-invalid-entries'
  | 'timing-from-audio'
  | 'unsupported-codec';

export interface RepairReport {
  method: 'nidx' | 'scan';
  indexBoxes: number;
  width: number;
  height: number;
  fps: number;
  videoFrames: number;
  keyframes: number;
  audioFrames: number;
  /** Frames recovered after the last index box by structural scanning. */
  tailVideoFrames: number;
  tailAudioFrames: number;
  droppedEntries: number;
  durationSeconds: number;
  warnings: WarningCode[];
}

export interface RepairPlan {
  /** ftyp + moov + mdat header. The output is these bytes followed by input[dataStart, dataEnd). */
  header: Uint8Array;
  dataStart: number;
  dataEnd: number;
  report: RepairReport;
}

export interface RepairOptions {
  /** Recover frames written after the last index box (default true). */
  tail?: boolean;
  /** Ignore camera index boxes and scan the raw stream (video only). */
  forceScan?: boolean;
  onProgress?: (stage: 'index' | 'verify' | 'scan', fraction: number) => void;
}

export type RepairErrorCode = 'no-video-found' | 'no-codec-config' | 'unsupported-codec';

export class RepairError extends Error {
  readonly code: RepairErrorCode;

  constructor(code: RepairErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig for AAC-LC. */
export function aacLcConfig(sampleRate: number, channels: number): Uint8Array {
  const index = AAC_RATES.indexOf(sampleRate);
  if (index === -1) {
    // Escape code 0xf followed by the explicit 24-bit rate.
    const bits = (2n << 35n) | (0xfn << 31n) | (BigInt(sampleRate) << 7n) | (BigInt(channels) << 3n);
    return Uint8Array.from({ length: 5 }, (_, i) => Number((bits >> BigInt(32 - i * 8)) & 0xffn));
  }
  const v = (2 << 11) | (index << 7) | (channels << 3);
  return Uint8Array.of(v >> 8, v & 0xff);
}

interface TopBox {
  type: string;
  offset: number;
  headerSize: number;
  size: number;
}

/** Top-level boxes, trusting sizes only as far as the file actually goes. */
async function topLevelBoxes(reader: Reader): Promise<TopBox[]> {
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

/** NAL types of a length-prefixed sample, reading only the 5-byte NAL headers. */
async function sampleTypes(reader: Reader, sample: Sample): Promise<{ types: number[]; headers: number[] } | null> {
  const end = sample.offset + sample.size;
  if (end > reader.size) return null;
  const types: number[] = [];
  const headers: number[] = [];
  let pos = sample.offset;
  while (pos + 5 <= end) {
    const h = await reader.read(pos, 5);
    const len = u32be(h, 0);
    if (len === 0) break; // alignment padding
    if (h[4]! & 0x80 || pos + 4 + len > end) return null;
    types.push(nalType(h[4]!));
    headers.push(h[4]!);
    pos += 4 + len;
  }
  return types.some((t) => t === NAL_SLICE || t === NAL_IDR) ? { types, headers } : null;
}

const uniqueBytes = (list: Uint8Array[]): Uint8Array[] => {
  const seen = new Set<string>();
  return list.filter((b) => {
    const key = Array.from(b).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function codecConfig(paramSets: Uint8Array[]): { avcC: Uint8Array; sps: ReturnType<typeof parseSps> } {
  const sps = uniqueBytes(paramSets.filter((n) => nalType(n[0]!) === NAL_SPS));
  const pps = uniqueBytes(paramSets.filter((n) => nalType(n[0]!) === NAL_PPS));
  if (!sps.length || !pps.length) {
    // HEVC parameter sets have a different header layout (type in bits 1..6).
    const hevc = paramSets.some((n) => ((n[0]! >> 1) & 0x3f) === 32);
    throw hevc
      ? new RepairError('unsupported-codec', 'H.265/HEVC recordings are not supported yet')
      : new RepairError('no-codec-config', 'Could not find the H.264 SPS/PPS in the file');
  }
  return { avcC: buildAvcC(sps, pps), sps: parseSps(sps[0]!) };
}

function ppsId(nal: Uint8Array): number {
  // pic_parameter_set_id is the first Exp-Golomb value; count its leading zero bits.
  let zeros = 0;
  for (let bit = 8; bit < nal.length * 8 && !((nal[bit >> 3]! >> (7 - (bit & 7))) & 1); bit++) zeros++;
  let value = 0;
  for (let k = 0, bit = 8 + zeros + 1; k < zeros; k++, bit++) value = value * 2 + ((nal[bit >> 3]! >> (7 - (bit & 7))) & 1);
  return 2 ** zeros - 1 + value;
}

const KNOWN_PROFILES = new Set([66, 77, 88, 100, 110, 122, 244]);

function validSps(nal: Uint8Array): boolean {
  try {
    const sps = parseSps(nal);
    return KNOWN_PROFILES.has(sps.profileIdc) && sps.width >= 16 && sps.width <= 8192 && sps.height >= 16 && sps.height <= 8192;
  } catch {
    return false;
  }
}

/**
 * Looks for SPS/PPS in the first part of the stream, Annex B or length-prefixed.
 * Random bytes match the pattern often, so a PPS only counts right after a valid SPS.
 */
async function findParamSetsInStream(reader: Reader, from: number): Promise<Uint8Array[]> {
  const data = await reader.read(from, 64 << 20);
  const nalAt = (i: number): Uint8Array | null => {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 4]! & 0x80) return null;
    if (data[i + 2] === 0 && data[i + 3] === 1) return splitAnnexB(data.subarray(i, i + 512))[0] ?? null;
    const len = u32be(data, i);
    return len >= 2 && len < 512 && i + 4 + len <= data.length ? data.slice(i + 4, i + 4 + len) : null;
  };
  for (let i = 0; i + 8 < data.length; i++) {
    if (nalType(data[i + 4]!) !== NAL_SPS) continue;
    const sps = nalAt(i);
    if (!sps || !validSps(sps)) continue;
    const found = [sps];
    // The PPS follows within a few bytes (after the SPS and its start code or length).
    for (let j = i + 4 + sps.length; j < i + 4 + sps.length + 16 && j + 8 < data.length; j++) {
      if (nalType(data[j + 4]!) !== NAL_PPS) continue;
      const pps = nalAt(j);
      if (pps && pps.length < 64) {
        found.push(pps);
        break;
      }
    }
    if (found.length === 2) return found;
  }
  return [];
}

interface Collected {
  method: 'nidx' | 'scan';
  boxes: NidxBox[];
  video: VideoSample[];
  audio: Sample[];
  tailVideo: number;
  tailAudio: number;
  dropped: number;
  paramSets: Uint8Array[];
  fps: number;
  sampleRate: number;
  channels: number;
  width: number;
  height: number;
}

async function collectFromIndex(reader: Reader, boxes: NidxBox[], options: RepairOptions): Promise<Collected> {
  const info = boxes.find((b) => b.info.width > 0)?.info ?? boxes[0]!.info;
  const paramSets = boxes.find((b) => b.paramSets.length)?.paramSets ?? [];
  const videoMap = new Map<number, number>();
  const audioMap = new Map<number, number>();
  for (const b of boxes) {
    for (const s of b.video) videoMap.set(s.offset, s.size);
    for (const s of b.audio) audioMap.set(s.offset, s.size);
  }
  const model: StreamModel = { videoHeaders: new Set(), maxVideoSize: 0, audioLead: new Set(), align: 4 };
  const video: VideoSample[] = [];
  let dropped = 0;
  const entries = [...videoMap].sort((a, b) => a[0] - b[0]);
  for (const [k, [offset, size]] of entries.entries()) {
    const parsed = size > 4 ? await sampleTypes(reader, { offset, size }) : null;
    if (!parsed) {
      dropped++;
      continue;
    }
    parsed.headers.forEach((h, i) => {
      const t = parsed.types[i];
      if (t === NAL_SLICE || t === NAL_IDR) model.videoHeaders.add(h);
    });
    model.maxVideoSize = Math.max(model.maxVideoSize, size);
    video.push({ offset, size, keyframe: parsed.types.includes(NAL_IDR) });
    if (k % 256 === 0) options.onProgress?.('verify', k / entries.length);
  }
  const audio: Sample[] = [];
  for (const [offset, size] of [...audioMap].sort((a, b) => a[0] - b[0])) {
    if (size > 0 && offset + size <= reader.size) audio.push({ offset, size });
    else dropped++;
  }
  const audioSizes = new Set(audio.map((a) => a.size));
  if (audioSizes.size === 1) model.audioSize = audio[0]!.size;
  for (const a of audio.filter((_, i) => i % 16 === 0)) model.audioLead.add((await reader.read(a.offset, 1))[0]!);

  let tailVideo = 0;
  let tailAudio = 0;
  if (options.tail !== false && video.length) {
    const lastEnd = [...video, ...audio].reduce((end, s) => Math.max(end, s.offset + s.size), 0);
    const tail = await new RawScanner(reader, model).scan(lastEnd);
    tailVideo = tail.video.length;
    tailAudio = tail.audio.length;
    video.push(...tail.video);
    audio.push(...tail.audio);
  }
  return {
    method: 'nidx',
    boxes,
    video,
    audio,
    tailVideo,
    tailAudio,
    dropped,
    paramSets,
    fps: info.fps,
    sampleRate: info.sampleRate,
    channels: info.channels,
    width: info.width,
    height: info.height,
  };
}

async function collectByScanning(reader: Reader, options: RepairOptions): Promise<Collected> {
  const boxes = await topLevelBoxes(reader);
  const mdat = boxes.find((b) => b.type === 'mdat');
  const start = mdat ? mdat.offset + mdat.headerSize : 0;
  const paramSets = await findParamSetsInStream(reader, start);
  const maxPpsId = Math.max(0, ...paramSets.filter((n) => nalType(n[0]!) === NAL_PPS).map(ppsId));
  const video = await scanVideoOnly(reader, start, { maxPpsId, onProgress: (f) => options.onProgress?.('scan', f) });
  return {
    method: 'scan',
    boxes: [],
    video,
    audio: [],
    tailVideo: 0,
    tailAudio: 0,
    dropped: 0,
    paramSets,
    fps: 0,
    sampleRate: 0,
    channels: 0,
    width: 0,
    height: 0,
  };
}

export async function planRepair(reader: Reader, options: RepairOptions = {}): Promise<RepairPlan> {
  const warnings: WarningCode[] = [];
  if ((await topLevelBoxes(reader)).some((b) => b.type === 'moov')) warnings.push('file-has-moov');

  const boxes = options.forceScan ? [] : await findNidxBoxes(reader, (f) => options.onProgress?.('index', f));
  const c = boxes.length ? await collectFromIndex(reader, boxes, options) : await collectByScanning(reader, options);
  if (c.method === 'scan') warnings.push('no-index-video-only');
  if (c.dropped) warnings.push('dropped-invalid-entries');
  if (!c.video.length) throw new RepairError('no-video-found', 'No recoverable video frames were found');

  const { avcC, sps } = codecConfig(c.paramSets);
  const video = [...c.video].sort((a, b) => a.offset - b.offset);
  // A decoder needs to start on an IDR frame, so drop anything before the first one.
  const firstKey = video.findIndex((s) => s.keyframe);
  const playable = firstKey > 0 ? video.slice(firstKey) : video;

  let timescale: number;
  let sampleDelta: number;
  if (c.fps > 0) [timescale, sampleDelta] = [c.fps * 1000, 1000];
  else if (sps.timing) [timescale, sampleDelta] = [sps.timing.timeScale, sps.timing.frameDuration];
  else [timescale, sampleDelta] = [30000, 1000];

  const audioSamples = [...c.audio].sort((a, b) => a.offset - b.offset);
  const hasAudio = audioSamples.length > 0 && c.sampleRate > 0 && c.channels > 0;
  if (hasAudio) {
    // The audio clock is exact (1024 samples per AAC frame). If the nominal
    // frame rate disagrees with it, the camera dropped frames: stretch video
    // timing to the audio length so the two stay in sync.
    const audioSeconds = (audioSamples.length * 1024) / c.sampleRate;
    const videoSeconds = (playable.length * sampleDelta) / timescale;
    if (Math.abs(videoSeconds - audioSeconds) / audioSeconds > 0.01) {
      timescale = 90000;
      sampleDelta = Math.max(1, Math.round((audioSeconds * timescale) / playable.length));
      warnings.push('timing-from-audio');
    }
  }

  const videoTrack: VideoTrack = {
    codec: 'avc1',
    width: c.width || sps.width,
    height: c.height || sps.height,
    timescale,
    sampleDelta,
    avcC,
    samples: playable,
  };
  const audioTrack: AudioTrack | undefined = hasAudio
    ? { codec: 'mp4a', sampleRate: c.sampleRate, channels: c.channels, asc: aacLcConfig(c.sampleRate, c.channels), samples: audioSamples }
    : undefined;

  const all = [...playable, ...(audioTrack?.samples ?? [])];
  // Plain loops: spreading 100k+ samples into Math.min would overflow the stack.
  let dataStart = Infinity;
  let dataEnd = 0;
  for (const s of all) {
    dataStart = Math.min(dataStart, s.offset);
    dataEnd = Math.max(dataEnd, s.offset + s.size);
  }
  const header = buildMp4Header({ video: videoTrack, audio: audioTrack, dataStart, dataEnd, tool: 'video-repair' });

  return {
    header: header.bytes,
    dataStart,
    dataEnd,
    report: {
      method: c.method,
      indexBoxes: c.boxes.length,
      width: videoTrack.width,
      height: videoTrack.height,
      fps: timescale / sampleDelta,
      videoFrames: playable.length,
      keyframes: playable.filter((s) => s.keyframe).length,
      audioFrames: audioTrack?.samples.length ?? 0,
      tailVideoFrames: c.tailVideo,
      tailAudioFrames: c.tailAudio,
      droppedEntries: c.dropped + (video.length - playable.length),
      durationSeconds: (playable.length * sampleDelta) / timescale,
      warnings,
    },
  };
}
