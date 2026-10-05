# video-repair

**Use it in your browser: https://psychonek.github.io/video-repair/** (your file is never uploaded)

Free repair for MP4 recordings that were cut off before the camera finalized
them, typically a dashcam losing power mid-recording. Such files have all the
audio and video data but no `moov` atom (the index), so players refuse them.

No re-encoding: the tool writes a new `ftyp` + `moov` and wraps the original
bytes in a fresh `mdat`, so the picture is bit-identical to what the camera
recorded.

## How it works

1. **Camera index (Novatek chipsets).** Many dashcams (LAMAX, Viofo, 70mai,
   Garmin and plenty of unbranded ones) write a `free` box holding an `nidx`
   index about once a second. Each lists the offset and size of every video
   and audio frame plus the parameter sets. The tool collects all of them,
   verifies every entry against the actual NAL structure, and rebuilds exact
   sample tables, audio included.
2. **Tail recovery.** Frames written after the last index box (up to about a
   second) are recovered by walking the stream with the layout learned from
   the indexed part.
3. **Data scan (video only).** Without a camera index, every position that
   looks like the start of a length-prefixed picture becomes a candidate, and a
   weighted interval schedule picks the real frames: a candidate that ends
   exactly where another begins is trusted, false matches lose to the real
   frames they overlap. On the test recordings it recovers exactly the frames
   the muxer wrote.
4. **Reference file.** Phones, action cameras and many other devices keep the
   codec settings (SPS/PPS/VPS) only in the moov, which is exactly what is
   missing. A healthy recording from the same device supplies them.

Both **H.264 and H.265/HEVC** are supported. Streams with **B-frames** get
composition offsets (`ctts` plus an edit list) computed from each picture's
order count, so frames are shown in the right order and audio stays in sync.

Timing comes from the camera's frame rate. When audio is present and the
nominal frame rate disagrees with the audio clock (dropped frames), video
timing is stretched to the audio length.

## Usage

The web page needs nothing installed. The CLI requires Node.js 24+ (it runs
the TypeScript sources directly).

```sh
npm install
node src/cli.ts damaged.MP4                       # writes damaged_fixed.mp4
node src/cli.ts damaged.MP4 out.mp4 --dry-run     # report only
node src/cli.ts phone.mp4 --reference good.mp4    # codec settings from a healthy file
```

| Option | Effect |
| --- | --- |
| `--reference <file>` | healthy recording from the same device, for codec settings |
| `--mode auto\|index\|scan` | camera index when present (default), index only, or data scan |
| `--fps <n>` | force the frame rate when the stored one is wrong |
| `--no-audio` | leave the audio track out |
| `--no-tail` | skip frames written after the last index entry |
| `--no-sync` | keep the nominal frame rate even if it disagrees with the audio |

The web page has the same options under "More repair options".

## Limitations

- Audio is recovered only from cameras with a Novatek index. The data scan
  restores the picture without sound, since raw AAC frames cannot be delimited
  without decoding them.
- Audio is assumed to be AAC for Novatek indexes (the only codec seen in
  practice); a reference file supplies the exact AAC configuration.

## Development

```sh
npm run check         # typecheck + unit tests
npm run dev           # web page with hot reload
npm run deploy:patch  # gate, tag, push, follow the GitHub Pages deploy
```

Tests include real x264/x265 recordings (`test/data`) with their moov
stripped; the muxer's own sample table is the ground truth.

## License

MIT

The core (`src/core`) has no Node dependencies and reads input through a
small `Reader` interface, so the same code runs in a browser on a `File`
without uploading anything.
