import { splitAnnexB } from './bits.ts';
import { u32be } from './bytes.ts';
import { CODECS, detectCodec, H264, type VideoCodec } from './codec.ts';
import { buildMp4Header } from './mp4.ts';
import { compositionOffsets } from './order.ts';
import { readReference, ReferenceError, topLevelBoxes, type ReferenceInfo } from './mp4read.ts';
import { findNidxBoxes, type NidxBox } from './novatek.ts';
import type { Reader } from './reader.ts';
import { RawScanner, type StreamModel } from './scan.ts';
import { scanVideoOnly } from './videoscan.ts';
import type { AudioTrack, Sample, VideoSample, VideoTrack } from './types.ts';

export type RepairMode = 'auto' | 'index' | 'scan';

export type WarningCode =
  | 'file-has-moov'
  | 'no-index-video-only'
  | 'dropped-invalid-entries'
  | 'timing-from-audio'
  | 'codec-from-reference';

export interface RepairReport {
  method: 'nidx' | 'scan';
  codec: VideoCodec['name'];
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
  /** auto: camera index when present, else data scan. index/scan force one method. */
  mode?: RepairMode;
  /** Recover frames written after the last index box (default true). */
  tail?: boolean;
  /** Keep the audio track (default true). */
  audio?: boolean;
  /** Frame rate override, for cameras whose stored rate is wrong. */
  fps?: number;
  /** Stretch video timing to the audio clock when the two disagree (default true). */
  syncToAudio?: boolean;
  /** A healthy recording from the same camera, used for codec settings. */
  reference?: Reader;
  onProgress?: (stage: 'index' | 'verify' | 'scan', fraction: number) => void;
}

export type RepairErrorCode = 'no-video-found' | 'no-codec-config' | 'no-camera-index' | 'bad-reference';

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

/** NAL types and slice header bytes of a length-prefixed sample, reading only the NAL headers. */
async function sampleTypes(reader: Reader, codec: VideoCodec, sample: Sample): Promise<{ types: number[]; headers: number[] } | null> {
  const end = sample.offset + sample.size;
  if (end > reader.size) return null;
  const types: number[] = [];
  const headers: number[] = [];
  let pos = sample.offset;
  while (pos + 6 <= end) {
    const h = await reader.read(pos, 6);
    const len = u32be(h, 0);
    if (len === 0) break; // alignment padding
    if (!codec.validHeader(h[4]!, h[5]!) || pos + 4 + len > end) return null;
    types.push(codec.nalType(h[4]!));
    headers.push(h[4]!);
    pos += 4 + len;
  }
  return types.some((t) => codec.isSlice(t)) ? { types, headers } : null;
}

interface StreamParams {
  codec: VideoCodec;
  paramSets: Uint8Array[];
}

/**
 * Looks for parameter sets in the first part of the stream, Annex B or
 * length-prefixed, for either codec. Random bytes match the pattern often, so
 * an SPS must parse, and PPS/VPS only count when found right next to it.
 */
async function findParamSetsInStream(reader: Reader, from: number): Promise<StreamParams | null> {
  const data = await reader.read(from, 64 << 20);
  const nalAt = (codec: VideoCodec, i: number, type: number): Uint8Array | null => {
    if (data[i] !== 0 || data[i + 1] !== 0 || i + 6 > data.length) return null;
    if (!codec.validHeader(data[i + 4]!, data[i + 5]!) || codec.nalType(data[i + 4]!) !== type) return null;
    if (data[i + 2] === 0 && data[i + 3] === 1) return splitAnnexB(data.subarray(i, i + 1024))[0] ?? null;
    const len = u32be(data, i);
    return len >= 3 && len < 512 && i + 4 + len <= data.length ? data.slice(i + 4, i + 4 + len) : null;
  };
  const near = (codec: VideoCodec, from: number, to: number, type: number): Uint8Array | null => {
    for (let j = Math.max(0, from); j < Math.min(to, data.length - 6); j++) {
      const nal = nalAt(codec, j, type);
      if (nal && nal.length < 256) return nal;
    }
    return null;
  };
  for (let i = 0; i + 8 < data.length; i++) {
    for (const codec of CODECS) {
      const sps = nalAt(codec, i, codec.spsType);
      if (!sps || !codec.validSps(sps)) continue;
      const end = i + 4 + sps.length;
      const pps = near(codec, end, end + 64, codec.ppsType);
      const vps = codec.vpsType === undefined ? null : near(codec, i - 256, i, codec.vpsType);
      if (pps && (codec.vpsType === undefined || vps)) return { codec, paramSets: [...(vps ? [vps] : []), sps, pps] };
    }
  }
  return null;
}

interface Collected {
  method: 'nidx' | 'scan';
  codec: VideoCodec;
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

async function collectFromIndex(reader: Reader, boxes: NidxBox[], reference: ReferenceInfo | undefined, options: RepairOptions): Promise<Collected> {
  const info = boxes.find((b) => b.info.width > 0)?.info ?? boxes[0]!.info;
  const paramSets = boxes.find((b) => b.paramSets.length)?.paramSets ?? [];
  const codec = detectCodec(paramSets) ?? reference?.codec ?? H264;
  const videoMap = new Map<number, number>();
  const audioMap = new Map<number, number>();
  for (const b of boxes) {
    for (const s of b.video) videoMap.set(s.offset, s.size);
    for (const s of b.audio) audioMap.set(s.offset, s.size);
  }
  const model: StreamModel = { codec, videoHeaders: new Set(), maxVideoSize: 0, audioLead: new Set(), align: 4 };
  const video: VideoSample[] = [];
  let dropped = 0;
  const entries = [...videoMap].sort((a, b) => a[0] - b[0]);
  for (const [k, [offset, size]] of entries.entries()) {
    const parsed = size > 6 ? await sampleTypes(reader, codec, { offset, size }) : null;
    if (!parsed) {
      dropped++;
      continue;
    }
    parsed.headers.forEach((h, i) => codec.isSlice(parsed.types[i]!) && model.videoHeaders.add(h));
    model.maxVideoSize = Math.max(model.maxVideoSize, size);
    video.push({ offset, size, keyframe: parsed.types.some((t) => codec.isKeyframe(t)) });
    if (k % 256 === 0) options.onProgress?.('verify', k / entries.length);
  }
  const audio: Sample[] = [];
  for (const [offset, size] of [...audioMap].sort((a, b) => a[0] - b[0])) {
    if (size > 0 && offset + size <= reader.size) audio.push({ offset, size });
    else dropped++;
  }
  if (new Set(audio.map((a) => a.size)).size === 1) model.audioSize = audio[0]!.size;
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
    codec,
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

async function collectByScanning(reader: Reader, reference: ReferenceInfo | undefined, options: RepairOptions): Promise<Collected> {
  const boxes = await topLevelBoxes(reader);
  const mdat = boxes.find((b) => b.type === 'mdat');
  const start = mdat ? mdat.offset + mdat.headerSize : 0;
  const stream = await findParamSetsInStream(reader, start);
  const codec = stream?.codec ?? reference?.codec;
  if (!codec) throw new RepairError('no-codec-config', 'No codec settings in the file; add a healthy reference recording from the same camera');
  const paramSets = stream?.paramSets ?? [];
  const ppsIds = [...paramSets, ...(reference?.paramSets ?? [])].filter((n) => codec.nalType(n[0]!) === codec.ppsType).map((n) => codec.ppsId(n));
  const maxPpsId = Math.max(0, ...ppsIds);
  const video = await scanVideoOnly(reader, start, { codec, maxPpsId, onProgress: (f) => options.onProgress?.('scan', f) });
  return {
    method: 'scan',
    codec,
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

async function loadReference(reader: Reader | undefined): Promise<ReferenceInfo | undefined> {
  if (!reader) return undefined;
  try {
    return await readReference(reader);
  } catch (err) {
    if (err instanceof ReferenceError) throw new RepairError('bad-reference', err.message);
    throw err;
  }
}

export async function planRepair(reader: Reader, options: RepairOptions = {}): Promise<RepairPlan> {
  const mode = options.mode ?? 'auto';
  const warnings: WarningCode[] = [];
  if ((await topLevelBoxes(reader)).some((b) => b.type === 'moov')) warnings.push('file-has-moov');
  const reference = await loadReference(options.reference);

  const boxes = mode === 'scan' ? [] : await findNidxBoxes(reader, (f) => options.onProgress?.('index', f));
  if (mode === 'index' && !boxes.length) throw new RepairError('no-camera-index', 'This file has no camera index (nidx boxes)');
  const c = boxes.length ? await collectFromIndex(reader, boxes, reference, options) : await collectByScanning(reader, reference, options);
  if (c.method === 'scan') warnings.push('no-index-video-only');
  if (c.dropped) warnings.push('dropped-invalid-entries');
  if (!c.video.length) throw new RepairError('no-video-found', 'No recoverable video frames were found');

  // The file's own parameter sets win; the reference fills in when they are missing.
  let setup = c.codec.setup(c.paramSets);
  if (!setup && reference?.codec === c.codec) {
    setup = c.codec.setup(reference.paramSets);
    if (setup) warnings.push('codec-from-reference');
  }
  if (!setup) throw new RepairError('no-codec-config', 'No codec settings in the file; add a healthy reference recording from the same camera');

  const video = [...c.video].sort((a, b) => a.offset - b.offset);
  // A decoder needs to start on a keyframe, so drop anything before the first one.
  const firstKey = video.findIndex((s) => s.keyframe);
  const playable = firstKey > 0 ? video.slice(firstKey) : video;

  let timescale: number;
  let sampleDelta: number;
  const timing = reference?.timing ?? setup.timing;
  if (options.fps && options.fps > 0) [timescale, sampleDelta] = [Math.round(options.fps * 1000), 1000];
  else if (c.fps > 0) [timescale, sampleDelta] = [c.fps * 1000, 1000];
  else if (timing) [timescale, sampleDelta] = [timing.timeScale, timing.frameDuration];
  else [timescale, sampleDelta] = [30000, 1000];

  const audioSamples = options.audio === false ? [] : [...c.audio].sort((a, b) => a.offset - b.offset);
  const hasAudio = audioSamples.length > 0 && c.sampleRate > 0 && c.channels > 0;
  if (hasAudio && !options.fps && options.syncToAudio !== false) {
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

  const paramSets = c.paramSets.length && c.codec.setup(c.paramSets) ? c.paramSets : (reference?.paramSets ?? []);
  const composition = await compositionOffsets(reader, c.codec, paramSets, playable);

  const videoTrack: VideoTrack = {
    sampleEntry: c.codec.sampleEntry,
    configBox: c.codec.configBox,
    config: setup.config,
    width: c.width || setup.width,
    height: c.height || setup.height,
    timescale,
    sampleDelta,
    samples: playable,
    compositionOffsets: composition?.offsets,
    presentationDelay: composition?.delay,
  };
  const refAudio = reference?.audio?.sampleRate === c.sampleRate ? reference.audio : undefined;
  const audioTrack: AudioTrack | undefined = hasAudio
    ? {
        codec: 'mp4a',
        sampleRate: c.sampleRate,
        channels: c.channels,
        asc: refAudio?.asc ?? aacLcConfig(c.sampleRate, c.channels),
        samples: audioSamples,
      }
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
      codec: c.codec.name,
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
