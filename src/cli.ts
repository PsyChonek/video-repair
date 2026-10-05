#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { parse } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import type { Reader } from './core/reader.ts';
import { planRepair, RepairError, type RepairMode } from './core/repair.ts';

const USAGE = `Usage: video-repair <damaged.mp4> [output.mp4] [options]

Rebuilds the index (moov atom) of an MP4 recording that was cut off before it
was finalized, typically a dashcam that lost power mid-recording.

  --reference <file>  healthy recording from the same camera, for codec settings
                      (needed for phones, action cams and other files without them)
  --mode <mode>       auto (default), index (camera index only), scan (data scan, video only)
  --fps <n>           force the frame rate, e.g. 29.97
  --no-audio          leave the audio track out
  --no-tail           skip frames written after the camera's last index entry
  --no-sync           keep the nominal frame rate even if it disagrees with the audio
  --dry-run           analyze and print the report without writing a file`;

const MODES = new Set<RepairMode>(['auto', 'index', 'scan']);

async function fileReader(path: string): Promise<Reader & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(len);
      if (len) await handle.read(buf, 0, len, offset);
      return buf;
    },
    close: () => handle.close(),
  };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      reference: { type: 'string' },
      mode: { type: 'string', default: 'auto' },
      fps: { type: 'string' },
      'no-audio': { type: 'boolean', default: false },
      'no-tail': { type: 'boolean', default: false },
      'no-sync': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [input, outputArg] = positionals;
  if (values.help || !input) {
    console.log(USAGE);
    return input || values.help ? 0 : 1;
  }
  const mode = values.mode as RepairMode;
  const fps = values.fps === undefined ? undefined : Number(values.fps);
  if (!MODES.has(mode) || (fps !== undefined && !(fps > 0 && fps <= 1000))) {
    console.error(USAGE);
    return 1;
  }
  const { dir, name } = parse(input);
  const output = outputArg ?? `${dir ? `${dir}/` : ''}${name}_fixed.mp4`;

  const reader = await fileReader(input);
  const reference = values.reference ? await fileReader(values.reference) : undefined;
  try {
    let lastStage = '';
    const plan = await planRepair(reader, {
      mode,
      fps,
      reference,
      tail: !values['no-tail'],
      audio: !values['no-audio'],
      syncToAudio: !values['no-sync'],
      onProgress: (stage, fraction) => {
        const label = `${stage} ${Math.round(fraction * 100)}%`;
        if (label !== lastStage) process.stderr.write(`\r${label.padEnd(16)}`);
        lastStage = label;
      },
    });
    process.stderr.write('\r'.padEnd(17) + '\r');
    const r = plan.report;
    console.log(`Method:      ${r.method === 'nidx' ? `camera index (${r.indexBoxes} index boxes)` : 'structural scan'}`);
    console.log(`Codec:       ${r.codec === 'hevc' ? 'H.265/HEVC' : 'H.264/AVC'}`);
    console.log(`Video:       ${r.width}x${r.height} @ ${r.fps.toFixed(2)} fps, ${r.videoFrames} frames (${r.keyframes} keyframes)`);
    console.log(`Audio:       ${r.audioFrames ? `${r.audioFrames} AAC frames` : 'none'}`);
    console.log(`Tail:        ${r.tailVideoFrames} video + ${r.tailAudioFrames} audio frames recovered after last index`);
    console.log(`Duration:    ${r.durationSeconds.toFixed(2)} s`);
    if (r.droppedEntries) console.log(`Dropped:     ${r.droppedEntries} unusable entries`);
    if (r.warnings.length) console.log(`Warnings:    ${r.warnings.join(', ')}`);
    if (values['dry-run']) return 0;

    const out = createWriteStream(output);
    out.write(plan.header);
    await pipeline(createReadStream(input, { start: plan.dataStart, end: plan.dataEnd - 1 }), out);
    console.log(`Written:     ${output}`);
    return 0;
  } catch (err) {
    if (err instanceof RepairError) {
      console.error(`Cannot repair: ${err.message} (${err.code})`);
      return 2;
    }
    throw err;
  } finally {
    await reader.close();
    await reference?.close();
  }
}

process.exitCode = await main();
