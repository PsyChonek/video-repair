// Recordings encoded by ffmpeg (x264 / x265, B-frames, AAC) with the moov
// stripped, the way a power cut leaves them. The muxer's own sample table is
// the ground truth for what the scanner must recover.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { H264, HEVC } from '../src/core/codec.ts';
import { readReference } from '../src/core/mp4read.ts';
import { compositionOffsets } from '../src/core/order.ts';
import { memoryReader } from '../src/core/reader.ts';
import { planRepair, RepairError } from '../src/core/repair.ts';
import { scanVideoOnly } from '../src/core/videoscan.ts';
import { readTruth } from './truth.ts';

const load = (name: string) => new Uint8Array(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const key = (s: { offset: number; size: number }) => `${s.offset}+${s.size}`;

const cases = [
  { file: 'h264-aac.mp4', codec: H264, reference: 'h264-aac-ref.mp4' },
  { file: 'hevc-aac.mp4', codec: HEVC, reference: 'hevc-inband.mp4' },
  { file: 'hevc-inband.mp4', codec: HEVC, reference: 'hevc-inband.mp4' },
] as const;

for (const c of cases) {
  test(`${c.file}: scan finds exactly the frames the muxer wrote`, async () => {
    const truth = readTruth(load(c.file));
    const got = await scanVideoOnly(memoryReader(truth.broken), 0, { codec: c.codec, maxPpsId: 0 });
    assert.deepEqual(got.map(key), truth.video.map(key));
  });

  test(`${c.file}: B-frame presentation order matches the original`, async () => {
    const truth = readTruth(load(c.file));
    const ref = await readReference(memoryReader(load(c.reference)));
    const samples = truth.video.map((v) => ({ ...v, keyframe: false }));
    const comp = await compositionOffsets(memoryReader(truth.broken), c.codec, ref.paramSets, samples);
    assert.ok(comp, 'expected composition offsets for a B-frame stream');
    assert.deepEqual(
      comp.offsets.map((o, i) => i + o - comp.delay),
      truth.videoRank,
    );
  });
}

test('a file without codec settings asks for a reference, and repairs with one', async () => {
  const truth = readTruth(load('h264-aac.mp4'));
  await assert.rejects(planRepair(memoryReader(truth.broken)), (e: unknown) => e instanceof RepairError && e.code === 'no-codec-config');
  const plan = await planRepair(memoryReader(truth.broken), { reference: memoryReader(load('h264-aac-ref.mp4')) });
  assert.equal(plan.report.codec, 'h264');
  assert.equal(plan.report.videoFrames, truth.video.length);
  assert.ok(plan.report.warnings.includes('codec-from-reference'));
});

test('HEVC with in-band parameter sets repairs without a reference', async () => {
  const truth = readTruth(load('hevc-inband.mp4'));
  const plan = await planRepair(memoryReader(truth.broken));
  assert.equal(plan.report.codec, 'hevc');
  assert.equal(plan.report.width, 320);
  assert.equal(plan.report.height, 240);
  assert.equal(plan.report.videoFrames, truth.video.length);
});

test('reference parsing reads codec, size, timing and AAC config', async () => {
  const ref = await readReference(memoryReader(load('hevc-aac.mp4')));
  assert.equal(ref.codec.name, 'hevc');
  assert.deepEqual([ref.width, ref.height], [320, 240]);
  assert.ok(ref.timing && Math.abs(ref.timing.timeScale / ref.timing.frameDuration - 30) < 0.01);
  assert.equal(ref.audio?.sampleRate, 16000);
  assert.equal(ref.audio?.channels, 1);
});

test('a reference without a moov is rejected clearly', async () => {
  const truth = readTruth(load('h264-aac.mp4'));
  await assert.rejects(
    planRepair(memoryReader(truth.broken), { reference: memoryReader(truth.broken) }),
    (e: unknown) => e instanceof RepairError && e.code === 'bad-reference',
  );
});
