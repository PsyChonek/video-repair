export interface Sample {
  /** Absolute offset in the damaged input file. */
  offset: number;
  size: number;
}

export interface VideoSample extends Sample {
  keyframe: boolean;
}

export interface VideoTrack {
  sampleEntry: 'avc1' | 'hvc1';
  configBox: 'avcC' | 'hvcC';
  /** avcC or hvcC payload. */
  config: Uint8Array;
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
  samples: VideoSample[];
  /** Per-sample presentation minus decode position, in frames, already shifted to be >= 0 (B-frames). */
  compositionOffsets?: number[];
  /** Frames to skip at the start so the first presented frame shows at time 0. */
  presentationDelay?: number;
}

export interface AudioTrack {
  codec: 'mp4a';
  sampleRate: number;
  channels: number;
  /** AAC AudioSpecificConfig. */
  asc: Uint8Array;
  samples: Sample[];
}
