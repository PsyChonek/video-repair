# video-repair

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
   and audio frame plus the SPS/PPS. The tool collects all of them, verifies
   every entry against the actual H.264 NAL structure, and rebuilds exact
   sample tables, audio included.
2. **Tail recovery.** Frames written after the last index box (up to about a
   second) are recovered by walking the stream with the layout learned from
   the indexed part. Disable with `--no-tail`.
3. **Fallback scan (video only).** Without a camera index, every position
   that looks like the start of a length-prefixed H.264 picture becomes a
   candidate, and a weighted interval schedule picks the real frames. On the
   reference LAMAX recording it matches the camera index exactly.

Timing comes from the camera's frame rate. When audio is present and the
nominal frame rate disagrees with the audio clock (dropped frames), video
timing is stretched to the audio length so they stay in sync.

## Usage

Requires Node.js 24+ (runs the TypeScript sources directly).

```sh
npm install
node src/cli.ts damaged.MP4                # writes damaged_fixed.mp4
node src/cli.ts damaged.MP4 out.mp4 --dry-run
node src/cli.ts damaged.MP4 out.mp4 --scan  # force the video-only fallback
```

## Limitations

- H.264 only. H.265/HEVC cameras are detected and reported, not repaired yet.
- AAC audio is assumed for Novatek indexes (the only codec seen in practice).
- The fallback scan recovers video only.

## Development

```sh
npm run check   # typecheck + unit tests
```

The core (`src/core`) has no Node dependencies and reads input through a
small `Reader` interface, so the same code runs in a browser on a `File`
without uploading anything.
