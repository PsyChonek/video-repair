import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fourcc, u32be } from '../src/core/bytes.ts';
import { parseSps } from '../src/core/h264.ts';
import { memoryReader } from '../src/core/reader.ts';
import { aacLcConfig, planRepair, RepairError } from '../src/core/repair.ts';
import { buildFixture, SPS, type FixtureItem } from './fixture.ts';

/** Concatenates the plan into the output file, as the CLI and browser do. */
function render(data: Uint8Array, plan: { header: Uint8Array; dataStart: number; dataEnd: number }): Uint8Array {
  const out = new Uint8Array(plan.header.length + plan.dataEnd - plan.dataStart);
  out.set(plan.header);
  out.set(data.subarray(plan.dataStart, plan.dataEnd), plan.header.length);
  return out;
}

function findBox(buf: Uint8Array, path: string[], start = 0, end = buf.length): { at: number; size: number } | null {
  const [head, ...rest] = path;
  for (let pos = start; pos + 8 <= end; ) {
    const size = u32be(buf, pos);
    if (size < 8) return null;
    if (fourcc(buf, pos + 4) === head) {
      if (!rest.length) return { at: pos, size };
      // Containers whose children start after a fixed-size sample entry or header.
      const skip = head === 'stsd' ? 16 : 8;
      return findBox(buf, rest, pos + skip, pos + size);
    }
    pos += size;
  }
  return null;
}

/** Reads one track's chunk offsets and sample sizes back out of the written moov. */
function readTrack(out: Uint8Array, trak: { at: number; size: number }): { offsets: number[]; sizes: number[]; sync: number[] | null } {
  const stbl = findBox(out, ['mdia', 'minf', 'stbl'], trak.at + 8, trak.at + trak.size)!;
  const inStbl = (type: string) => findBox(out, [type], stbl.at + 8, stbl.at + stbl.size);
  const stco = inStbl('stco')!;
  const stsz = inStbl('stsz')!;
  const stss = inStbl('stss');
  const count = u32be(out, stco.at + 12);
  const offsets = Array.from({ length: count }, (_, i) => u32be(out, stco.at + 16 + i * 4));
  const constant = u32be(out, stsz.at + 12);
  const sizes = Array.from({ length: count }, (_, i) => constant || u32be(out, stsz.at + 20 + i * 4));
  const sync = stss ? Array.from({ length: u32be(out, stss.at + 12) }, (_, i) => u32be(out, stss.at + 16 + i * 4)) : null;
  return { offsets, sizes, sync };
}

function traks(out: Uint8Array): { at: number; size: number }[] {
  const moov = findBox(out, ['moov'])!;
  const list: { at: number; size: number }[] = [];
  for (let pos = moov.at + 8; pos < moov.at + moov.size; pos += u32be(out, pos)) {
    if (fourcc(out, pos + 4) === 'trak') list.push({ at: pos, size: u32be(out, pos) });
  }
  return list;
}

const ofKind = (items: FixtureItem[], kind: FixtureItem['kind']) => items.filter((i) => i.kind === kind);

test('rebuilds sample tables from nidx boxes and recovers the unindexed tail', async () => {
  const fx = buildFixture({ seconds: 3, tailFrames: 3 });
  const plan = await planRepair(memoryReader(fx.data));
  const all = [...fx.indexed, ...fx.tail];

  assert.equal(plan.report.method, 'nidx');
  assert.equal(plan.report.indexBoxes, 3);
  assert.equal(plan.report.videoFrames, ofKind(all, 'video').length);
  assert.equal(plan.report.audioFrames, ofKind(all, 'audio').length);
  assert.equal(plan.report.tailVideoFrames, 3);
  assert.equal(plan.report.tailAudioFrames, 1);
  assert.equal(plan.report.width, 2560);
  assert.equal(plan.report.height, 1440);

  const out = render(fx.data, plan);
  assert.equal(fourcc(out, 4), 'ftyp');
  const [videoTrak, audioTrak] = traks(out);
  for (const [trak, kind] of [[videoTrak!, 'video'], [audioTrak!, 'audio']] as const) {
    const { offsets, sizes } = readTrack(out, trak);
    const expected = ofKind(all, kind);
    assert.equal(offsets.length, expected.length);
    expected.forEach((item, i) => {
      assert.equal(sizes[i], item.size);
      // Every rebuilt offset must point at the same bytes the camera wrote.
      assert.deepEqual(out.subarray(offsets[i]!, offsets[i]! + item.size), fx.data.subarray(item.offset, item.offset + item.size));
    });
  }
  const { sync } = readTrack(out, videoTrak!);
  const keyframes = ofKind(all, 'video').flatMap((v, i) => (v.keyframe ? [i + 1] : []));
  assert.deepEqual(sync, keyframes);
});

test('--no-tail keeps only indexed frames', async () => {
  const fx = buildFixture({ seconds: 2, tailFrames: 4 });
  const plan = await planRepair(memoryReader(fx.data), { tail: false });
  assert.equal(plan.report.videoFrames, ofKind(fx.indexed, 'video').length);
  assert.equal(plan.report.tailVideoFrames, 0);
});

test('recovers the second whose index box was never written', async () => {
  const fx = buildFixture({ seconds: 2, tailFrames: 0 });
  const lastVideo = ofKind(fx.indexed, 'video').at(-1)!;
  const cut = fx.data.subarray(0, lastVideo.offset + 10);
  const plan = await planRepair(memoryReader(cut));
  const complete = fx.indexed.filter((i) => i.offset + i.size <= cut.length);
  assert.equal(plan.report.indexBoxes, 1);
  assert.equal(plan.report.videoFrames, ofKind(complete, 'video').length);
  assert.equal(plan.report.audioFrames, ofKind(complete, 'audio').length);
  assert.ok(plan.dataEnd <= cut.length);
});

test('drops index entries that do not hold a valid NAL sample', async () => {
  const fx = buildFixture({ seconds: 2, tailFrames: 0 });
  const data = fx.data.slice();
  const victim = ofKind(fx.indexed, 'video')[5]!;
  data[victim.offset + 4] = 0xff; // forbidden_zero_bit set
  const plan = await planRepair(memoryReader(data));
  assert.ok(plan.report.warnings.includes('dropped-invalid-entries'));
  assert.equal(plan.report.videoFrames, ofKind(fx.indexed, 'video').length - 1);
});

test('parses the camera SPS', () => {
  const sps = parseSps(SPS);
  assert.equal(sps.width, 2560);
  assert.equal(sps.height, 1440);
  assert.equal(sps.profileIdc, 100);
  assert.deepEqual(sps.timing, { timeScale: 60000, frameDuration: 2000 });
});

test('builds AAC-LC AudioSpecificConfig', () => {
  assert.deepEqual([...aacLcConfig(16000, 1)], [0x14, 0x08]);
  assert.deepEqual([...aacLcConfig(44100, 2)], [0x12, 0x10]);
  assert.equal(aacLcConfig(50000, 1).length, 5);
});

test('falls back to a video-only scan when there is no camera index', async () => {
  const fx = buildFixture({ seconds: 3, tailFrames: 3 });
  const plan = await planRepair(memoryReader(fx.data), { mode: 'scan' });
  const expected = ofKind([...fx.indexed, ...fx.tail], 'video');
  assert.equal(plan.report.method, 'scan');
  assert.ok(plan.report.warnings.includes('no-index-video-only'));
  assert.equal(plan.report.audioFrames, 0);
  const out = render(fx.data, plan);
  const { offsets, sizes } = readTrack(out, traks(out)[0]!);
  assert.deepEqual(sizes, expected.map((v) => v.size));
  expected.forEach((v, i) => assert.deepEqual(out.subarray(offsets[i]!, offsets[i]! + v.size), fx.data.subarray(v.offset, v.offset + v.size)));
});

test('cachedReader returns the same bytes as the underlying reader', async () => {
  const { cachedReader } = await import('../src/core/reader.ts');
  const data = Uint8Array.from({ length: 10_000 }, (_, i) => (i * 31) & 0xff);
  const cached = cachedReader(memoryReader(data), 256, 2);
  for (const [offset, length] of [[0, 5], [250, 20], [255, 2], [9_990, 50], [1_000, 600], [512, 256]] as const) {
    assert.deepEqual(await cached.read(offset, length), data.subarray(offset, Math.min(offset + length, data.length)));
  }
});

test('index mode refuses a file without a camera index', async () => {
  const fx = buildFixture({ seconds: 1 });
  const noIndex = fx.data.slice();
  // Break every nidx signature.
  for (let i = 0; i + 4 <= noIndex.length; i++) if (noIndex[i] === 0x6e && noIndex[i + 1] === 0x69 && noIndex[i + 2] === 0x64) noIndex[i] = 0x4e;
  await assert.rejects(planRepair(memoryReader(noIndex), { mode: 'index' }), (e: unknown) => e instanceof RepairError && e.code === 'no-camera-index');
});

test('options: frame rate override, no audio, no audio sync', async () => {
  const fx = buildFixture({ seconds: 2 });
  const plan = await planRepair(memoryReader(fx.data), { fps: 25, audio: false });
  assert.equal(plan.report.fps, 25);
  assert.equal(plan.report.audioFrames, 0);
  assert.equal(traks(render(fx.data, plan)).length, 1);
  const synced = await planRepair(memoryReader(fx.data), { syncToAudio: false });
  assert.ok(!synced.report.warnings.includes('timing-from-audio'));
  assert.equal(synced.report.fps, 30);
});
