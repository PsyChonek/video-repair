// H.265/HEVC pieces: 2-byte NAL headers, SPS fields for the sample entry,
// and the HEVCDecoderConfigurationRecord (hvcC).

import { BitReader, toRbsp } from './bits.ts';
import { ByteWriter } from './bytes.ts';

export const HEVC_VPS = 32;
export const HEVC_SPS = 33;
export const HEVC_PPS = 34;
export const HEVC_AUD = 35;
export const HEVC_SEI_PREFIX = 39;
export const HEVC_SEI_SUFFIX = 40;

export const hevcNalType = (header: number): number => (header >> 1) & 0x3f;

/** Coded slice segments: TRAIL..RASL (0-9) and the IRAP types BLA/IDR/CRA (16-21). */
export const isHevcSlice = (type: number): boolean => type <= 9 || (type >= 16 && type <= 21);

/** Random access points a player can start decoding from. */
export const isHevcKeyframe = (type: number): boolean => type >= 16 && type <= 21;

/** Second header byte: nuh_layer_id must be 0 for base-layer video, temporal id plus 1 must be >= 1. */
export const validHevcHeader = (h0: number, h1: number): boolean => !(h0 & 0x80) && !(h0 & 1) && h1 >= 1 && h1 <= 7;

/** slice_pic_parameter_set_id is too deep to reach cheaply; first_slice_segment_in_pic_flag is the key bit. */
export function isHevcPictureStart(header: number, rbsp: Uint8Array, maxPpsId: number): boolean {
  if (!rbsp.length || !(rbsp[0]! & 0x80)) return false;
  try {
    const r = new BitReader(rbsp);
    r.bit(); // first_slice_segment_in_pic_flag
    const type = hevcNalType(header);
    if (type >= 16 && type <= 23) r.bit(); // no_output_of_prior_pics_flag
    return r.ue() <= maxPpsId;
  } catch {
    return false;
  }
}

/** pps_pic_parameter_set_id: the first Exp-Golomb value after the 2-byte header. */
export function hevcPpsId(nal: Uint8Array): number {
  return new BitReader(toRbsp(nal.subarray(2, 10))).ue();
}

export interface HevcSpsInfo {
  separateColourPlane: boolean;
  log2MaxPocLsb: number;
  /** general_profile_space .. general_level_idc, 12 bytes copied verbatim into hvcC. */
  profileTierLevel: Uint8Array;
  profileIdc: number;
  maxSubLayers: number;
  temporalIdNesting: boolean;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  width: number;
  height: number;
}

export function parseHevcSps(nal: Uint8Array): HevcSpsInfo {
  const rbsp = toRbsp(nal.subarray(2));
  const r = new BitReader(rbsp);
  r.bits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  const temporalIdNesting = r.bit() === 1;
  const profileTierLevel = rbsp.slice(1, 13);
  if (profileTierLevel.length < 12) throw new Error('SPS too short');
  const profileIdc = profileTierLevel[0]! & 0x1f;
  r.skip(96); // general profile, tier, level
  const subProfile: boolean[] = [];
  const subLevel: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.bit() === 1);
    subLevel.push(r.bit() === 1);
  }
  if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1));
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  const separateColourPlane = chromaFormatIdc === 3 && r.bit() === 1;
  let width = r.ue();
  let height = r.ue();
  if (r.bit()) {
    const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subH = chromaFormatIdc === 1 ? 2 : 1;
    const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()];
    width -= (left + right) * subW;
    height -= (top + bottom) * subH;
  }
  const bitDepthLuma = r.ue() + 8;
  const bitDepthChroma = r.ue() + 8;
  const log2MaxPocLsb = r.ue() + 4;
  return {
    separateColourPlane,
    log2MaxPocLsb,
    profileTierLevel,
    profileIdc,
    maxSubLayers: maxSubLayersMinus1 + 1,
    temporalIdNesting,
    chromaFormatIdc,
    bitDepthLuma,
    bitDepthChroma,
    width,
    height,
  };
}

/** HEVCDecoderConfigurationRecord with 4-byte NAL lengths; parameter sets live only here (hvc1). */
export function buildHvcC(vps: Uint8Array[], sps: Uint8Array[], pps: Uint8Array[]): Uint8Array {
  const first = sps[0];
  if (!first) throw new Error('No SPS available');
  const info = parseHevcSps(first);
  const w = new ByteWriter();
  w.u8(1).bytes(info.profileTierLevel);
  w.u16(0xf000); // min_spatial_segmentation_idc = 0
  w.u8(0xfc); // parallelismType unknown
  w.u8(0xfc | info.chromaFormatIdc);
  w.u8(0xf8 | (info.bitDepthLuma - 8));
  w.u8(0xf8 | (info.bitDepthChroma - 8));
  w.u16(0); // avgFrameRate unspecified
  w.u8((info.maxSubLayers << 3) | ((info.temporalIdNesting ? 1 : 0) << 2) | 3);
  const arrays: [number, Uint8Array[]][] = [
    [HEVC_VPS, vps],
    [HEVC_SPS, sps],
    [HEVC_PPS, pps],
  ];
  w.u8(arrays.length);
  for (const [type, list] of arrays) {
    w.u8(0x80 | type).u16(list.length); // array_completeness = 1
    for (const nal of list) w.u16(nal.length).bytes(nal);
  }
  return w.toBytes();
}

export interface HevcPpsInfo {
  dependentSliceSegments: boolean;
  outputFlagPresent: boolean;
  extraSliceHeaderBits: number;
}

export function parseHevcPps(nal: Uint8Array): HevcPpsInfo {
  const r = new BitReader(toRbsp(nal.subarray(2, 32)));
  r.ue(); // pps_pic_parameter_set_id
  r.ue(); // pps_seq_parameter_set_id
  return { dependentSliceSegments: r.bit() === 1, outputFlagPresent: r.bit() === 1, extraSliceHeaderBits: r.bits(3) };
}

/** Sub-layer non-reference pictures: the even types below 16 (TRAIL_N, TSA_N, ...). */
const isSubLayerNonRef = (type: number): boolean => type <= 14 && type % 2 === 0;

/**
 * Picture order count of successive pictures in decode order, as comparable
 * keys. IDR and BLA pictures restart the count, so each starts a new epoch.
 */
export function hevcPictureOrder(sps: HevcSpsInfo, pps: HevcPpsInfo): (h0: number, h1: number, rbsp: Uint8Array) => number | null {
  const maxLsb = 2 ** sps.log2MaxPocLsb;
  let epoch = 0;
  let prevMsb = 0;
  let prevLsb = 0;
  return (h0, h1, rbsp) => {
    try {
      const type = hevcNalType(h0);
      const r = new BitReader(toRbsp(rbsp));
      r.bit(); // first_slice_segment_in_pic_flag
      if (type >= 16 && type <= 23) r.bit(); // no_output_of_prior_pics_flag
      r.ue(); // slice_pic_parameter_set_id
      r.bits(pps.extraSliceHeaderBits);
      r.ue(); // slice_type
      if (pps.outputFlagPresent) r.bit();
      if (sps.separateColourPlane) r.bits(2);
      if (type === 19 || type === 20 || (type >= 16 && type <= 18)) {
        // IDR has no POC LSB (it is 0); BLA keeps its LSB but resets the MSB.
        const lsb = type >= 19 ? 0 : r.bits(sps.log2MaxPocLsb);
        epoch++;
        [prevMsb, prevLsb] = [0, lsb];
        return epoch * 2 ** 32 + lsb;
      }
      const lsb = r.bits(sps.log2MaxPocLsb);
      let msb = prevMsb;
      if (lsb < prevLsb && prevLsb - lsb >= maxLsb / 2) msb += maxLsb;
      else if (lsb > prevLsb && lsb - prevLsb > maxLsb / 2) msb -= maxLsb;
      // prevTid0Pic: temporal id 0, not RASL/RADL, not a sub-layer non-reference picture.
      const tid = (h1 & 7) - 1;
      if (tid === 0 && !(type >= 6 && type <= 9) && !isSubLayerNonRef(type)) [prevMsb, prevLsb] = [msb, lsb];
      return epoch * 2 ** 32 + msb + lsb;
    } catch {
      return null;
    }
  };
}
