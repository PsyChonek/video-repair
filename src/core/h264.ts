import { ByteWriter, u32be } from './bytes.ts';

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export const nalType = (header: number): number => header & 0x1f;

/** Splits an Annex B byte stream (00 00 01 / 00 00 00 01 start codes) into NAL units. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; payload: number }[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ at: i > 0 && data[i - 1] === 0 ? i - 1 : i, payload: i + 3 });
      i += 2;
    }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1]!.at : data.length;
    while (end > s.payload && data[end - 1] === 0) end--;
    return data.subarray(s.payload, end);
  });
}

/**
 * Walks a sample made of 4-byte length-prefixed NAL units. Returns the NAL
 * types, or null when the lengths do not tile the sample. Zero padding after
 * the last NAL is allowed, since some cameras align samples to 4 bytes.
 */
export function sampleNalTypes(sample: Uint8Array): number[] | null {
  const types: number[] = [];
  let pos = 0;
  while (pos + 5 <= sample.length) {
    const len = u32be(sample, pos);
    if (len === 0) break;
    const header = sample[pos + 4]!;
    if (header & 0x80 || pos + 4 + len > sample.length) return null;
    types.push(nalType(header));
    pos += 4 + len;
  }
  for (; pos < sample.length; pos++) if (sample[pos] !== 0) return null;
  return types.length ? types : null;
}

/** Removes emulation prevention bytes (00 00 03) so the RBSP can be bit-parsed. */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]!);
  }
  return Uint8Array.from(out);
}

class BitReader {
  private pos = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS ended early');
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) if (++zeros > 31) throw new Error('Bad Exp-Golomb code');
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  }
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
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const lists = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
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
  const info: SpsInfo = { profileIdc, constraintFlags, levelIdc, width, height };
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
