// One interface over H.264 and H.265, so the index, tail and fallback scanners
// do not care which codec the camera used. Both store 4-byte length-prefixed
// NAL units in MP4; they differ in header size, type numbering and config box.

import * as avc from './h264.ts';
import * as hevc from './hevc.ts';

export interface CodecSetup {
  config: Uint8Array;
  width: number;
  height: number;
  /** Frame timing from the SPS, when the encoder wrote it. */
  timing?: { timeScale: number; frameDuration: number };
}

export interface VideoCodec {
  name: 'h264' | 'hevc';
  sampleEntry: 'avc1' | 'hvc1';
  configBox: 'avcC' | 'hvcC';
  /** NAL header length in bytes (1 for H.264, 2 for H.265). */
  headerBytes: number;
  nalType(header: number): number;
  /** Header bytes are well formed (forbidden bit, HEVC layer and temporal id). */
  validHeader(h0: number, h1: number): boolean;
  isSlice(type: number): boolean;
  isKeyframe(type: number): boolean;
  /** Non-VCL units that may precede the slices of a picture (AUD, SEI, parameter sets). */
  isPrefix(type: number): boolean;
  /** Non-VCL units that may follow the slices of a picture (HEVC suffix SEI). */
  isSuffix(type: number): boolean;
  spsType: number;
  ppsType: number;
  /** Extra parameter set type the config needs (HEVC VPS). */
  vpsType?: number;
  /** First slice of a picture with a plausible header. `rbsp` starts after the NAL header. */
  isPictureStart(header: number, rbsp: Uint8Array, maxPpsId: number): boolean;
  ppsId(nal: Uint8Array): number;
  /**
   * The part of a slice NAL header that stays constant across a stream, used to
   * learn which headers are real: the whole byte for H.264 (ref_idc + type),
   * the temporal id byte for H.265, whose first byte varies with picture type.
   */
  headerKey(h0: number, h1: number): number;
  /** Rejects random bytes that happen to carry an SPS type. */
  validSps(nal: Uint8Array): boolean;
  setup(paramSets: Uint8Array[]): CodecSetup | null;
  /**
   * Returns a function giving each picture's presentation order key, fed the
   * first slice of every picture in decode order. Null when the stream's
   * ordering mode is unsupported (then decode order is assumed).
   */
  pictureOrder(paramSets: Uint8Array[]): ((h0: number, h1: number, rbsp: Uint8Array) => number | null) | null;
}

const uniqueBytes = (list: Uint8Array[]): Uint8Array[] => {
  const seen = new Set<string>();
  return list.filter((b) => {
    const key = b.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const AVC_PROFILES = new Set([66, 77, 88, 100, 110, 122, 244]);
const sane = (w: number, h: number) => w >= 16 && w <= 8192 && h >= 16 && h <= 8192;

export const H264: VideoCodec = {
  name: 'h264',
  sampleEntry: 'avc1',
  configBox: 'avcC',
  headerBytes: 1,
  nalType: avc.nalType,
  validHeader: (h0) => !(h0 & 0x80),
  isSlice: (t) => t === avc.NAL_SLICE || t === avc.NAL_IDR,
  isKeyframe: (t) => t === avc.NAL_IDR,
  isPrefix: (t) => t === 6 || t === 7 || t === 8 || t === 9 || t === 10 || t === 12,
  isSuffix: () => false,
  spsType: avc.NAL_SPS,
  ppsType: avc.NAL_PPS,
  isPictureStart: avc.isPictureStart,
  ppsId: avc.ppsId,
  headerKey: (h0) => h0,
  validSps(nal) {
    try {
      const sps = avc.parseSps(nal);
      return AVC_PROFILES.has(sps.profileIdc) && sane(sps.width, sps.height);
    } catch {
      return false;
    }
  },
  setup(paramSets) {
    const sps = uniqueBytes(paramSets.filter((n) => avc.nalType(n[0]!) === avc.NAL_SPS));
    const pps = uniqueBytes(paramSets.filter((n) => avc.nalType(n[0]!) === avc.NAL_PPS));
    if (!sps.length || !pps.length) return null;
    const info = avc.parseSps(sps[0]!);
    return { config: avc.buildAvcC(sps, pps), width: info.width, height: info.height, timing: info.timing };
  },
  pictureOrder(paramSets) {
    const sps = paramSets.find((n) => avc.nalType(n[0]!) === avc.NAL_SPS);
    const order = sps ? avc.avcPictureOrder(avc.parseSps(sps)) : null;
    return order && ((h0, _h1, rbsp) => order(h0, rbsp));
  },
};

export const HEVC: VideoCodec = {
  name: 'hevc',
  sampleEntry: 'hvc1',
  configBox: 'hvcC',
  headerBytes: 2,
  nalType: hevc.hevcNalType,
  validHeader: hevc.validHevcHeader,
  isSlice: hevc.isHevcSlice,
  isKeyframe: hevc.isHevcKeyframe,
  isPrefix: (t) => (t >= hevc.HEVC_VPS && t <= hevc.HEVC_AUD) || t === hevc.HEVC_SEI_PREFIX,
  isSuffix: (t) => t === hevc.HEVC_SEI_SUFFIX,
  spsType: hevc.HEVC_SPS,
  ppsType: hevc.HEVC_PPS,
  vpsType: hevc.HEVC_VPS,
  isPictureStart: hevc.isHevcPictureStart,
  ppsId: hevc.hevcPpsId,
  headerKey: (_h0, h1) => h1,
  validSps(nal) {
    try {
      const sps = hevc.parseHevcSps(nal);
      return sps.profileIdc >= 1 && sps.profileIdc <= 11 && sps.chromaFormatIdc <= 3 && sane(sps.width, sps.height);
    } catch {
      return false;
    }
  },
  setup(paramSets) {
    const byType = (type: number) => uniqueBytes(paramSets.filter((n) => hevc.hevcNalType(n[0]!) === type));
    const [vps, sps, pps] = [byType(hevc.HEVC_VPS), byType(hevc.HEVC_SPS), byType(hevc.HEVC_PPS)];
    if (!vps.length || !sps.length || !pps.length) return null;
    const info = hevc.parseHevcSps(sps[0]!);
    return { config: hevc.buildHvcC(vps, sps, pps), width: info.width, height: info.height };
  },
  pictureOrder(paramSets) {
    const sps = paramSets.find((n) => hevc.hevcNalType(n[0]!) === hevc.HEVC_SPS);
    const pps = paramSets.find((n) => hevc.hevcNalType(n[0]!) === hevc.HEVC_PPS);
    return sps && pps ? hevc.hevcPictureOrder(hevc.parseHevcSps(sps), hevc.parseHevcPps(pps)) : null;
  },
};

export const CODECS = [H264, HEVC] as const;

/** Picks the codec whose parameter set types appear in the list. */
export function detectCodec(paramSets: Uint8Array[]): VideoCodec | null {
  for (const codec of [HEVC, H264]) {
    if (paramSets.some((n) => n.length > 2 && codec.nalType(n[0]!) === codec.spsType && codec.validHeader(n[0]!, n[1]!) && codec.validSps(n))) {
      return codec;
    }
  }
  return null;
}
