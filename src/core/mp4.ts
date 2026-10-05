// Serializes a fresh ftyp + moov + mdat header. The mdat payload is the
// original byte range [dataStart, dataEnd) copied verbatim, so sample offsets
// only need shifting by a constant.

import { ByteWriter } from './bytes.ts';
import type { AudioTrack, Sample, VideoTrack } from './types.ts';

const MOVIE_TIMESCALE = 1000;
const UINT32_MAX = 2 ** 32 - 1;
const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

interface TrackLayout {
  id: number;
  handler: 'vide' | 'soun';
  timescale: number;
  sampleDelta: number;
  samples: Sample[];
  syncSamples?: number[];
  sampleEntry: (w: ByteWriter) => void;
}

export interface Mp4Input {
  video: VideoTrack;
  audio?: AudioTrack;
  dataStart: number;
  dataEnd: number;
  tool?: string;
}

export interface Mp4Header {
  bytes: Uint8Array;
  dataStart: number;
  dataEnd: number;
}

function writeFtyp(w: ByteWriter): void {
  w.box('ftyp', (b) => b.str('isom').u32(0x200).str('isomiso2avc1mp41'));
}

function writeMvhd(w: ByteWriter, duration: number, nextTrackId: number): void {
  const v1 = duration > UINT32_MAX;
  w.fullBox('mvhd', v1 ? 1 : 0, 0, (b) => {
    if (v1) b.u64(0).u64(0).u32(MOVIE_TIMESCALE).u64(duration);
    else b.u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(duration);
    b.u32(0x10000).u16(0x100).zeros(10);
    for (const m of IDENTITY_MATRIX) b.u32(m);
    b.zeros(24).u32(nextTrackId);
  });
}

function writeTrack(w: ByteWriter, t: TrackLayout, offsets: number[], co64: boolean, size: { width: number; height: number }): void {
  const mediaDuration = t.samples.length * t.sampleDelta;
  const movieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / t.timescale);
  w.box('trak', (trak) => {
    trak.fullBox('tkhd', 0, 3, (b) => {
      b.u32(0).u32(0).u32(t.id).u32(0).u32(Math.min(movieDuration, UINT32_MAX)).zeros(8);
      b.u16(0).u16(t.handler === 'soun' ? 1 : 0).u16(t.handler === 'soun' ? 0x100 : 0).u16(0);
      for (const m of IDENTITY_MATRIX) b.u32(m);
      b.u32(size.width * 0x10000).u32(size.height * 0x10000);
    });
    trak.box('mdia', (mdia) => {
      mdia.fullBox('mdhd', 0, 0, (b) => b.u32(0).u32(0).u32(t.timescale).u32(Math.min(mediaDuration, UINT32_MAX)).u16(0x55c4).u16(0));
      mdia.fullBox('hdlr', 0, 0, (b) => {
        b.u32(0).str(t.handler).zeros(12).str(t.handler === 'vide' ? 'VideoHandler' : 'SoundHandler').u8(0);
      });
      mdia.box('minf', (minf) => {
        if (t.handler === 'vide') minf.fullBox('vmhd', 0, 1, (b) => b.zeros(8));
        else minf.fullBox('smhd', 0, 0, (b) => b.zeros(4));
        minf.box('dinf', (dinf) => dinf.fullBox('dref', 0, 0, (b) => b.u32(1).fullBox('url ', 0, 1, () => {})));
        minf.box('stbl', (stbl) => writeStbl(stbl, t, offsets, co64));
      });
    });
  });
}

function writeStbl(w: ByteWriter, t: TrackLayout, offsets: number[], co64: boolean): void {
  w.fullBox('stsd', 0, 0, (b) => {
    b.u32(1);
    t.sampleEntry(b);
  });
  w.fullBox('stts', 0, 0, (b) => b.u32(1).u32(t.samples.length).u32(t.sampleDelta));
  if (t.syncSamples && t.syncSamples.length < t.samples.length) {
    const sync = t.syncSamples;
    w.fullBox('stss', 0, 0, (b) => {
      b.u32(sync.length);
      for (const s of sync) b.u32(s);
    });
  }
  // One sample per chunk keeps the tables trivial; cost is ~8 bytes per sample.
  w.fullBox('stsc', 0, 0, (b) => b.u32(1).u32(1).u32(1).u32(1));
  const first = t.samples[0]?.size ?? 0;
  const constant = t.samples.every((s) => s.size === first);
  w.fullBox('stsz', 0, 0, (b) => {
    b.u32(constant ? first : 0).u32(t.samples.length);
    if (!constant) for (const s of t.samples) b.u32(s.size);
  });
  w.fullBox(co64 ? 'co64' : 'stco', 0, 0, (b) => {
    b.u32(offsets.length);
    for (const o of offsets) co64 ? b.u64(o) : b.u32(o);
  });
}

function videoEntry(v: VideoTrack): (w: ByteWriter) => void {
  return (w) =>
    w.box('avc1', (b) => {
      b.zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height);
      b.u32(0x480000).u32(0x480000).u32(0).u16(1);
      const name = 'video-repair';
      b.u8(name.length).str(name).zeros(31 - name.length);
      b.u16(0x18).u16(0xffff);
      b.box('avcC', (c) => c.bytes(v.avcC));
    });
}

function audioEntry(a: AudioTrack): (w: ByteWriter) => void {
  return (w) =>
    w.box('mp4a', (b) => {
      b.zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(a.sampleRate * 0x10000);
      b.fullBox('esds', 0, 0, (e) => {
        const dsi = a.asc.length;
        const dcd = 13 + 2 + dsi;
        e.u8(0x03).u8(3 + 2 + dcd + 3).u16(0).u8(0);
        e.u8(0x04).u8(dcd).u8(0x40).u8(0x15).u24(0).u32(0).u32(0);
        e.u8(0x05).u8(dsi).bytes(a.asc);
        e.u8(0x06).u8(1).u8(0x02);
      });
    });
}

function layouts(input: Mp4Input): TrackLayout[] {
  const { video, audio } = input;
  const syncSamples: number[] = [];
  video.samples.forEach((s, i) => s.keyframe && syncSamples.push(i + 1));
  const list: TrackLayout[] = [
    {
      id: 1,
      handler: 'vide',
      timescale: video.timescale,
      sampleDelta: video.sampleDelta,
      samples: video.samples,
      syncSamples,
      sampleEntry: videoEntry(video),
    },
  ];
  if (audio?.samples.length) {
    list.push({ id: 2, handler: 'soun', timescale: audio.sampleRate, sampleDelta: 1024, samples: audio.samples, sampleEntry: audioEntry(audio) });
  }
  return list;
}

function writeHeader(input: Mp4Input, shift: number, co64: boolean): Uint8Array {
  const tracks = layouts(input);
  const payload = input.dataEnd - input.dataStart;
  const largeMdat = payload + 8 > UINT32_MAX;
  const w = new ByteWriter();
  writeFtyp(w);
  const duration = Math.max(...tracks.map((t) => Math.round((t.samples.length * t.sampleDelta * MOVIE_TIMESCALE) / t.timescale)));
  w.box('moov', (moov) => {
    writeMvhd(moov, duration, tracks.length + 1);
    for (const t of tracks) {
      const size = t.handler === 'vide' ? { width: input.video.width, height: input.video.height } : { width: 0, height: 0 };
      writeTrack(moov, t, t.samples.map((s) => s.offset + shift), co64, size);
    }
    if (input.tool) {
      moov.box('udta', (u) =>
        u.fullBox('meta', 0, 0, (m) => {
          m.fullBox('hdlr', 0, 0, (h) => h.u32(0).str('mdir').str('appl').zeros(9));
          m.box('ilst', (l) => l.box('©too', (t) => t.box('data', (d) => d.u32(1).u32(0).str(input.tool!))));
        }),
      );
    }
  });
  if (largeMdat) w.u32(1).str('mdat').u64(payload + 16);
  else w.u32(payload + 8).str('mdat');
  return w.toBytes();
}

/**
 * Builds the header. Sizes depend on whether 64-bit chunk offsets are needed,
 * and the offsets depend on the header size, so measure once and then write.
 */
export function buildMp4Header(input: Mp4Input): Mp4Header {
  const co64 = input.dataEnd - input.dataStart + (1 << 24) > UINT32_MAX;
  const probe = writeHeader(input, 0, co64);
  const bytes = writeHeader(input, probe.length - input.dataStart, co64);
  if (bytes.length !== probe.length) throw new Error('Header size changed between passes');
  return { bytes, dataStart: input.dataStart, dataEnd: input.dataEnd };
}
