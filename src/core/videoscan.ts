// Video-only fallback for recordings without a camera index. Every position
// that looks like the start of a length-prefixed H.264 picture becomes a
// candidate, and a weighted interval schedule picks the frames. A garbage
// length that spans many real frames loses to the frames it would cover, and
// whatever sits between pictures (audio, GPS, padding) is simply skipped.

import { fourcc, u32be } from './bytes.ts';
import { isPictureStart, NAL_IDR, NAL_SLICE, nalType } from './h264.ts';
import type { Reader } from './reader.ts';
import type { VideoSample } from './types.ts';

const BLOCK = 4 << 20;
const OVERLAP = 64;
const MAX_FRAME = 4 << 20;
const FOLLOW_GAP = 4096;
const SKIP_BOXES = new Set(['free', 'skip', 'wide']);

export interface VideoScanOptions {
  maxPpsId?: number;
  onProgress?: (fraction: number) => void;
}

interface Candidate extends VideoSample {
  header: number;
  followed: boolean;
}

/**
 * Possible ends of a picture starting with a slice NAL ending at `firstEnd`:
 * just that slice, or extended over following slices of the same picture
 * (same NAL header, first_mb_in_slice != 0). The scheduler picks among them.
 */
async function pictureEnds(reader: Reader, start: number, header: number, firstEnd: number): Promise<number[]> {
  const ends = [firstEnd];
  for (let end = firstEnd; ends.length < 16; ) {
    const h = await reader.read(end, 6);
    if (h.length < 6 || h[4] !== header || h[5]! & 0x80) break;
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
  const maxPpsId = options.maxPpsId ?? 3;
  const found: Candidate[] = [];
  for (let base = start; base < reader.size; base += BLOCK) {
    const block = await reader.read(base, BLOCK + OVERLAP);
    const limit = Math.min(BLOCK, block.length - 13);
    for (let i = block.indexOf(0); i !== -1 && i < limit; i = block.indexOf(0, i + 1)) {
      const header = block[i + 4]!;
      const type = header & 0x1f;
      if (header & 0x80 || (type !== NAL_SLICE && type !== NAL_IDR)) continue;
      if (type === NAL_IDR && !(header & 0x60)) continue; // IDR pictures are always reference pictures
      const len = u32be(block, i);
      const offset = base + i;
      if (len < 2 || len > MAX_FRAME || offset + 4 + len > reader.size) continue;
      if (!isPictureStart(header, block.subarray(i + 5, i + 13), maxPpsId)) continue;
      for (const end of await pictureEnds(reader, offset, header, offset + 4 + len)) {
        found.push({ offset, size: end - offset, keyframe: type === NAL_IDR, header, followed: false });
      }
    }
    options.onProgress?.(Math.min(1, (base + BLOCK) / reader.size));
  }
  return found;
}

/** Marks candidates whose end is closely followed by another candidate or by the end of the file. */
async function markFollowed(reader: Reader, candidates: Candidate[]): Promise<void> {
  const starts = candidates.map((c) => c.offset).sort((a, b) => a - b);
  for (const c of candidates) {
    const after = await skipBoxes(reader, c.offset + c.size);
    const next = starts[lowerBound(starts, after)];
    c.followed = reader.size - after < FOLLOW_GAP || (next !== undefined && next - after < FOLLOW_GAP);
  }
}

/** NAL header bytes the stream really uses, judged by confirmed candidates only. */
function dominantHeaders(candidates: Candidate[]): Set<number> {
  const counts = new Map<number, number>();
  let total = 0;
  for (const c of candidates) {
    if (!c.followed) continue;
    counts.set(c.header, (counts.get(c.header) ?? 0) + 1);
    total++;
  }
  const min = Math.max(3, total * 0.01);
  return new Set([...counts].filter(([, n]) => n >= min).map(([h]) => h));
}

/**
 * Weighted interval scheduling. A followed candidate is almost certainly real
 * and weighs 1; an unconfirmed one weighs little, so a real keyframe beats the
 * false matches inside it, while many real frames beat one garbage span.
 */
function schedule(candidates: Candidate[]): VideoSample[] {
  const byEnd = [...candidates].sort((a, b) => a.offset + a.size - (b.offset + b.size));
  const ends = byEnd.map((c) => c.offset + c.size);
  const best = new Float64Array(byEnd.length + 1);
  const prev = new Int32Array(byEnd.length);
  byEnd.forEach((c, j) => {
    prev[j] = lowerBound(ends, c.offset + 1); // candidates ending at or before c starts
    best[j + 1] = Math.max(best[j]!, (c.followed ? 1 : 0.1) + best[prev[j]!]!);
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

export async function scanVideoOnly(reader: Reader, start: number, options: VideoScanOptions = {}): Promise<VideoSample[]> {
  const candidates = await findCandidates(reader, start, options);
  await markFollowed(reader, candidates);
  const headers = dominantHeaders(candidates);
  const filtered = candidates.filter((c) => headers.has(c.header));
  // Followed status depends on which candidates exist, so recompute after filtering.
  await markFollowed(reader, filtered);
  const picked = schedule(filtered);
  // Random bytes occasionally pass every check as a tiny "frame" between real
  // ones. Real P-frames shrink in static scenes, but not to 2% of the median.
  const sizes = picked.map((p) => p.size).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1] ?? 0;
  return picked.filter((p) => p.keyframe || p.size * 50 >= median);
}
