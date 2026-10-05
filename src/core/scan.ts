// Structural scanner for the last partial second after the final nidx box,
// where the layout learned from the indexed part tells us what to expect.

import { fourcc, u32be } from './bytes.ts';
import type { VideoCodec } from './codec.ts';
import type { Reader } from './reader.ts';
import type { Sample, VideoSample } from './types.ts';

export interface StreamModel {
  codec: VideoCodec;
  /** First NAL header bytes seen on known-good video samples (e.g. 0x65, 0x21). */
  videoHeaders: Set<number>;
  maxVideoSize: number;
  /** Fixed audio slot size, when the camera pads every AAC frame to one size. */
  audioSize?: number;
  /** First bytes seen on known-good audio samples. */
  audioLead: Set<number>;
  /** Items start on this alignment (4 for Novatek). */
  align: number;
}

export interface ScanResult {
  video: VideoSample[];
  audio: Sample[];
  /** Where scanning stopped. */
  end: number;
}

type Item =
  | { kind: 'video'; sample: VideoSample }
  | { kind: 'audio'; sample: Sample }
  | { kind: 'skip'; end: number };

const PEEK = 16;
const SKIP_BOXES = new Set(['free', 'skip', 'wide']);

const alignUp = (pos: number, align: number): number => Math.ceil(pos / align) * align;

export class RawScanner {
  private readonly reader: Reader;
  private readonly model: StreamModel;

  constructor(reader: Reader, model: StreamModel) {
    this.reader = reader;
    this.model = model;
  }

  private async peek(pos: number): Promise<Uint8Array> {
    return this.reader.read(pos, PEEK);
  }

  private plausibleNal(head: Uint8Array, pos: number): number | null {
    const { codec } = this.model;
    if (head.length < 6) return null;
    const len = u32be(head, 0);
    const header = head[4]!;
    if (len < 2 || !codec.validHeader(header, head[5]!) || pos + 4 + len > this.reader.size) return null;
    const type = codec.nalType(header);
    if (codec.isSlice(type)) {
      if (!this.model.videoHeaders.has(header) || len > this.model.maxVideoSize * 4) return null;
    } else if (!(codec.isPrefix(type) || codec.isSuffix(type)) || len > 4096) {
      return null;
    }
    return len;
  }

  /** Reads one access unit: optional non-VCL NALs, then the slices of one picture. */
  private async readVideo(pos: number): Promise<VideoSample | null> {
    let cursor = pos;
    let keyframe = false;
    let sawSlice = false;
    for (;;) {
      const head = await this.peek(cursor);
      const len = this.plausibleNal(head, cursor);
      if (len === null) break;
      const { codec } = this.model;
      const type = codec.nalType(head[4]!);
      const vcl = codec.isSlice(type);
      // The first slice of a picture starts with a 1 bit (first_mb_in_slice == 0
      // in H.264, first_slice_segment_in_pic_flag in H.265).
      if (vcl && sawSlice && head[4 + codec.headerBytes]! & 0x80) break;
      if (!vcl && sawSlice && !codec.isSuffix(type)) break;
      if (!vcl && !sawSlice && codec.isSuffix(type)) break;
      if (vcl) {
        sawSlice = true;
        keyframe ||= codec.isKeyframe(type);
      }
      cursor += 4 + len;
    }
    return sawSlice ? { offset: pos, size: cursor - pos, keyframe } : null;
  }

  private async skipRun(pos: number, value: number): Promise<number> {
    let cursor = pos;
    while (cursor < this.reader.size) {
      const block = await this.reader.read(cursor, 64 * 1024);
      const stop = block.findIndex((b) => b !== value);
      if (stop !== -1) return cursor + stop;
      cursor += block.length;
    }
    return cursor;
  }

  /** Classifies the item at `pos` without looking past it. */
  private async classify(pos: number): Promise<Item | null> {
    const head = await this.peek(pos);
    if (head.length < 8) return null;
    if (head[0] === 0xff && head[1] === 0xff && head[2] === 0xff && head[3] === 0xff) {
      return { kind: 'skip', end: await this.skipRun(pos, 0xff) };
    }
    if (SKIP_BOXES.has(fourcc(head, 4))) {
      const size = u32be(head, 0);
      if (size >= 8 && pos + size <= this.reader.size) return { kind: 'skip', end: pos + size };
    }
    if (this.plausibleNal(head, pos) !== null) {
      const sample = await this.readVideo(pos);
      if (sample) return { kind: 'video', sample };
    }
    const { audioSize, audioLead } = this.model;
    if (audioSize && audioLead.has(head[0]!) && pos + audioSize <= this.reader.size) {
      return { kind: 'audio', sample: { offset: pos, size: audioSize } };
    }
    return null;
  }

  private nextPos(item: Item): number {
    const end = item.kind === 'skip' ? item.end : item.sample.offset + item.sample.size;
    return item.kind === 'skip' ? end : alignUp(end, this.model.align);
  }

  /** A frame the camera was still writing when power was cut. */
  private async truncatedFrame(pos: number): Promise<boolean> {
    const head = await this.peek(pos);
    return head.length >= 5 && this.model.videoHeaders.has(head[4]!) && pos + 4 + u32be(head, 0) > this.reader.size;
  }

  /** Accepts an item only if whatever follows it also parses, or the file ends there. */
  private async confirmed(pos: number): Promise<Item | null> {
    const item = await this.classify(pos);
    if (!item) return null;
    const next = this.nextPos(item);
    if (this.reader.size - next < PEEK) return item;
    return (await this.classify(next)) || (await this.truncatedFrame(next)) ? item : null;
  }

  /** Walks items from `start` until the structure stops making sense. */
  async scan(start: number): Promise<ScanResult> {
    const result: ScanResult = { video: [], audio: [], end: start };
    let pos = alignUp(start, this.model.align);
    while (this.reader.size - pos >= PEEK) {
      const item = await this.confirmed(pos);
      if (!item) break;
      if (item.kind === 'video') result.video.push(item.sample);
      else if (item.kind === 'audio') result.audio.push(item.sample);
      pos = this.nextPos(item);
      result.end = pos;
    }
    return result;
  }
}
