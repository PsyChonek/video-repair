import { BitReader, toRbsp } from './bits.ts';
import { ByteWriter } from './bytes.ts';

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export const nalType = (header: number): number => header & 0x1f;

/** pic_parameter_set_id: the first Exp-Golomb value after the header byte. */
export function ppsId(nal: Uint8Array): number {
  return new BitReader(toRbsp(nal.subarray(1, 8))).ue();
}

/**
 * Cheap plausibility check of a slice header that starts a picture:
 * first_mb_in_slice == 0, a slice_type that fits the NAL type, a small PPS id.
 * `rbsp` is the bytes right after the NAL header byte.
 */
export function isPictureStart(header: number, rbsp: Uint8Array, maxPpsId: number): boolean {
  if (!rbsp.length || !(rbsp[0]! & 0x80)) return false;
  try {
    const r = new BitReader(rbsp);
    r.bit(); // first_mb_in_slice == 0
    const sliceType = r.ue();
    if (sliceType > 9) return false;
    const kind = sliceType % 5; // 0 P, 1 B, 2 I, 3 SP, 4 SI
    if (nalType(header) === NAL_IDR ? kind !== 2 && kind !== 4 : kind > 2) return false;
    return r.ue() <= maxPpsId;
  } catch {
    return false;
  }
}

export interface SpsInfo {
  separateColourPlane: boolean;
  log2MaxFrameNum: number;
  frameMbsOnly: boolean;
  pocType: number;
  /** Only meaningful for pocType 0. */
  log2MaxPocLsb: number;
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  width: number;
  height: number;
  /** Frame rate from VUI timing info, when present. */
  timing?: { timeScale: number; frameDuration: number };
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Parses the fields of an SPS NAL (header byte included) that the MP4 header needs. */
export function parseSps(nal: Uint8Array): SpsInfo {
  const r = new BitReader(toRbsp(nal.subarray(1)));
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit() === 1;
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const pocType = r.ue();
  let log2MaxPocLsb = 0;
  if (pocType === 0) {
    log2MaxPocLsb = r.ue() + 4;
  } else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
  r.bit(); // direct_8x8_inference_flag
  let width = widthMbs * 16;
  let height = (2 - frameMbsOnly) * heightMapUnits * 16;
  if (r.bit()) {
    const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()];
    const cropX = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
    const cropY = (chromaFormatIdc === 1 ? 2 : 1) * (2 - frameMbsOnly);
    width -= (left + right) * cropX;
    height -= (top + bottom) * cropY;
  }
  const info: SpsInfo = {
    separateColourPlane,
    log2MaxFrameNum,
    frameMbsOnly: frameMbsOnly === 1,
    pocType,
    log2MaxPocLsb,
    profileIdc,
    constraintFlags,
    levelIdc,
    width,
    height,
  };
  try {
    if (r.bit()) Object.assign(info, readVuiTiming(r));
  } catch {
    // VUI is optional for our purposes; a truncated one just means no timing hint.
  }
  return info;
}

function readVuiTiming(r: BitReader): Pick<SpsInfo, 'timing'> {
  if (r.bit()) {
    if (r.bits(8) === 255) r.bits(32); // aspect_ratio_idc == Extended_SAR
  }
  if (r.bit()) r.bit(); // overscan
  if (r.bit()) {
    r.bits(4);
    if (r.bit()) r.bits(24); // colour description
  }
  if (r.bit()) {
    r.ue();
    r.ue(); // chroma sample locations
  }
  if (!r.bit()) return {};
  const unitsInTick = r.bits(32);
  const timeScale = r.bits(32);
  if (!unitsInTick || !timeScale) return {};
  // Two ticks per frame for progressive content (one per field).
  return { timing: { timeScale, frameDuration: unitsInTick * 2 } };
}

/** AVCDecoderConfigurationRecord with 4-byte NAL lengths. */
export function buildAvcC(sps: Uint8Array[], pps: Uint8Array[]): Uint8Array {
  const first = sps[0];
  if (!first) throw new Error('No SPS available');
  const w = new ByteWriter();
  w.u8(1).u8(first[1]!).u8(first[2]!).u8(first[3]!).u8(0xff).u8(0xe0 | sps.length);
  for (const s of sps) w.u16(s.length).bytes(s);
  w.u8(pps.length);
  for (const p of pps) w.u16(p.length).bytes(p);
  return w.toBytes();
}

/**
 * Picture order count of successive pictures in decode order (POC type 0;
 * types 1 and 2 are not handled and yield null). Keys compare across IDRs:
 * each IDR starts a new epoch, since its POC restarts at 0.
 */
export function avcPictureOrder(sps: SpsInfo): ((header: number, rbsp: Uint8Array) => number | null) | null {
  if (sps.pocType !== 0) return null;
  const maxLsb = 2 ** sps.log2MaxPocLsb;
  let epoch = 0;
  let prevMsb = 0;
  let prevLsb = 0;
  return (header, rbsp) => {
    try {
      const r = new BitReader(toRbsp(rbsp));
      r.ue(); // first_mb_in_slice
      r.ue(); // slice_type
      r.ue(); // pic_parameter_set_id
      if (sps.separateColourPlane) r.bits(2);
      r.bits(sps.log2MaxFrameNum);
      if (!sps.frameMbsOnly && r.bit()) r.bit(); // field_pic_flag, bottom_field_flag
      const idr = nalType(header) === NAL_IDR;
      if (idr) {
        r.ue(); // idr_pic_id
        epoch++;
        prevMsb = 0;
        prevLsb = 0;
      }
      const lsb = r.bits(sps.log2MaxPocLsb);
      let msb = prevMsb;
      if (lsb < prevLsb && prevLsb - lsb >= maxLsb / 2) msb += maxLsb;
      else if (lsb > prevLsb && lsb - prevLsb > maxLsb / 2) msb -= maxLsb;
      if (header & 0x60) [prevMsb, prevLsb] = [msb, lsb]; // reference pictures carry the POC forward
      return epoch * 2 ** 32 + msb + lsb;
    } catch {
      return null;
    }
  };
}
