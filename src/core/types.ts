export interface Sample {
  /** Absolute offset in the damaged input file. */
  offset: number;
  size: number;
}

export interface VideoSample extends Sample {
  keyframe: boolean;
}

export interface VideoTrack {
  codec: 'avc1';
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
  avcC: Uint8Array;
  samples: VideoSample[];
}

export interface AudioTrack {
  codec: 'mp4a';
  sampleRate: number;
  channels: number;
  /** AAC AudioSpecificConfig. */
  asc: Uint8Array;
  samples: Sample[];
}
