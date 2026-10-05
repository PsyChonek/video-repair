// Video-only fallback for recordings without a camera index. Every position
// that looks like the start of a length-prefixed H.264/H.265 picture becomes a
// candidate, and a weighted interval schedule picks the frames. A garbage
// length that spans many real frames loses to the frames it would cover, and
// whatever sits between pictures (audio, GPS, padding) is simply skipped.

import { fourcc, u32be } from './bytes.ts';
import type { VideoCodec } from './codec.ts';
import type { Reader } from './reader.ts';
import type { VideoSample } from './types.ts';

const BLOCK = 4 << 20;
const OVERLAP = 64;
const MAX_FRAME = 4 << 20;
/** Alignment padding allowed between a picture and whatever follows it. */
const MAX_PADDING = 3;
const SKIP_BOXES = new Set(['free', 'skip', 'wide']);

export interface VideoScanOptions {
  codec: VideoCodec;
  maxPpsId?: number;
  onProgress?: (fraction: number) => void;
}

interface Candidate extends VideoSample {
  /** First NAL header byte of the picture's first slice. */
  header: number;
  /** codec.headerKey of that slice, for learning which headers are real. */
  key: number;
  followed: boolean;
}

const MAX_PREFIX = 64 * 1024;

/**
 * Walks AUD/SEI/parameter-set NAL units starting at `pos` to the first slice
 * they lead into. Returns that slice's position, or null if the chain breaks.
 */
async function prefixChain(reader: Reader, codec: VideoCodec, pos: number): Promise<number | null> {
  for (let hops = 0; hops < 8; hops++) {
    const h = await reader.read(pos, 6);
    if (h.length < 6 || !codec.validHeader(h[4]!, h[5]!)) return null;
    const type = codec.nalType(h[4]!);
    if (codec.isSlice(type)) return hops ? pos : null;
    const len = u32be(h, 0);
    if (!codec.isPrefix(type) || len < 2 || len > MAX_PREFIX) return null;
    pos += 4 + len;
  }
  return null;
}

/**
 * Possible ends of a picture starting with a slice NAL ending at `firstEnd`:
 * just that slice, or extended over following slices of the same picture
 * (same NAL header, first_mb_in_slice != 0). The scheduler picks among them.
 */
async function pictureEnds(reader: Reader, codec: VideoCodec, start: number, header: number, firstEnd: number): Promise<number[]> {
  const ends = [firstEnd];
  const firstBit = 4 + codec.headerBytes;
  for (let end = firstEnd; ends.length < 16; ) {
    const h = await reader.read(end, firstBit + 1);
    if (h.length < firstBit + 1 || h[4] !== header || h[firstBit]! & 0x80) break;
    const len = u32be(h, 0);
    if (len < 2 || end + 4 + len > reader.size || end + 4 + len - start > MAX_FRAME) break;
    end += 4 + len;
    ends.push(end);
  }
  return ends;
}

/** Position after any padding boxes at `pos`, allowing a few alignment bytes before each. */
async function skipBoxes(reader: Reader, pos: number): Promise<number> {
  for (let hop = 0; hop < 4; hop++) {
    const h = await reader.read(pos, 16);
    let skipped = false;
    for (let k = 0; k < 4 && k + 8 <= h.length; k++) {
      const size = u32be(h, k);
      if (size >= 8 && SKIP_BOXES.has(fourcc(h, k + 4))) {
        pos += k + size;
        skipped = true;
        break;
      }
    }
    if (!skipped) break;
  }
  return pos;
}

/** Index of the first element in sorted `values` that is >= `target`. */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function findCandidates(reader: Reader, start: number, options: VideoScanOptions): Promise<Candidate[]> {
  const { codec } = options;
  const maxPpsId = options.maxPpsId ?? 3;
  const hb = codec.headerBytes;
  const found: Candidate[] = [];
  for (let base = start; base < reader.size; base += BLOCK) {
    const block = await reader.read(base, BLOCK + OVERLAP);
    const limit = Math.min(BLOCK, block.length - 14);
    for (let i = block.indexOf(0); i !== -1 && i < limit; i = block.indexOf(0, i + 1)) {
      let header = block[i + 4]!;
      if (!codec.validHeader(header, block[i + 5]!)) continue;
      let type = codec.nalType(header);
      const offset = base + i;
      if (codec.isPrefix(type)) {
        // SEI, AUD or in-band parameter sets leading into a picture belong to its sample.
        const at = await prefixChain(reader, codec, offset);
        if (at === null) continue;
        const h = await reader.read(at, 14 + hb);
        header = h[4]!;
        type = codec.nalType(header);
        if (!codec.isPictureStart(header, h.subarray(4 + hb), maxPpsId)) continue;
        const len = u32be(h, 0);
        if (len < 2 || at + 4 + len > reader.size) continue;
        for (const end of await pictureEnds(reader, codec, at, header, at + 4 + len)) {
          if (end - offset <= MAX_FRAME) found.push({ offset, size: end - offset, keyframe: codec.isKeyframe(type), header, key: codec.headerKey(header, h[5]!), followed: false });
        }
        continue;
      }
      if (!codec.isSlice(type)) continue;
      if (codec.name === 'h264' && codec.isKeyframe(type) && !(header & 0x60)) continue; // IDR is always a reference
      const len = u32be(block, i);
      if (len < 2 || len > MAX_FRAME || offset + 4 + len > reader.size) continue;
      if (!codec.isPictureStart(header, block.subarray(i + 4 + hb, i + 12 + hb), maxPpsId)) continue;
      for (const end of await pictureEnds(reader, codec, offset, header, offset + 4 + len)) {
        found.push({ offset, size: end - offset, keyframe: codec.isKeyframe(type), header, key: codec.headerKey(header, block[i + 5]!), followed: false });
      }
    }
    options.onProgress?.(Math.min(1, (base + BLOCK) / reader.size));
  }
  return found;
}

/**
 * Marks candidates followed exactly by another candidate (after padding boxes
 * and a few alignment bytes) or by the end of the file. Random bytes almost
 * never end precisely where another plausible picture begins.
 */
async function markFollowed(reader: Reader, candidates: Candidate[]): Promise<void> {
  const starts = candidates.map((c) => c.offset).sort((a, b) => a - b);
  for (const c of candidates) {
    const after = await skipBoxes(reader, c.offset + c.size);
    const next = starts[lowerBound(starts, after)];
    c.followed = reader.size - after <= MAX_PADDING || (next !== undefined && next - after <= MAX_PADDING);
  }
}

/**
 * NAL header bytes the stream really uses: any header seen on an exactly
 * followed candidate (random bytes almost never are), plus keyframe headers,
 * which are rare but often followed by audio rather than another picture.
 */
function trustedHeaders(codec: VideoCodec, candidates: Candidate[]): Set<number> {
  return new Set(candidates.filter((c) => c.followed || codec.isKeyframe(codec.nalType(c.header))).map((c) => c.key));
}

/**
 * Weighted interval scheduling. A followed candidate is almost certainly real
 * and weighs 1. One followed by audio or other data cannot be confirmed and
 * weighs 0.3, with a size bonus too small to matter except between rivals: a
 * real frame outweighs a shorter false match inside it, while many real frames
 * beat one garbage span over them.
 */
const weight = (c: Candidate): number => (c.followed ? 1 : 0.3) + c.size / MAX_FRAME / 100;

function schedule(candidates: Candidate[]): VideoSample[] {
  const byEnd = [...candidates].sort((a, b) => a.offset + a.size - (b.offset + b.size));
  const ends = byEnd.map((c) => c.offset + c.size);
  const best = new Float64Array(byEnd.length + 1);
  const prev = new Int32Array(byEnd.length);
  byEnd.forEach((c, j) => {
    prev[j] = lowerBound(ends, c.offset + 1); // candidates ending at or before c starts
    best[j + 1] = Math.max(best[j]!, weight(c) + best[prev[j]!]!);
  });
  const picked: VideoSample[] = [];
  for (let j = byEnd.length; j > 0; ) {
    if (best[j] === best[j - 1]) {
      j--;
      continue;
    }
    const { offset, size, keyframe } = byEnd[j - 1]!;
    picked.push({ offset, size, keyframe });
    j = prev[j - 1]!;
  }
  return picked.reverse();
}

export async function scanVideoOnly(reader: Reader, start: number, options: VideoScanOptions): Promise<VideoSample[]> {
  const candidates = await findCandidates(reader, start, options);
  await markFollowed(reader, candidates);
  const headers = trustedHeaders(options.codec, candidates);
  const filtered = candidates.filter((c) => headers.has(c.key));
  // Followed status depends on which candidates exist, so recompute after filtering.
  await markFollowed(reader, filtered);
  const picked = schedule(filtered);
  // Random bytes occasionally pass every check as a tiny "frame" between real
  // ones. Real P-frames shrink in static scenes, but not to 2% of the median,
  // and real keyframes are never small.
  const sizes = picked.map((p) => p.size).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1] ?? 0;
  return picked.filter((p) => p.size * 50 >= median);
}
