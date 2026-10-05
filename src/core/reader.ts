/**
 * Random-access byte source. The CLI backs it with a file handle, the browser
 * with File.slice(), so the core never loads a whole multi-GB recording.
 */
export interface Reader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function memoryReader(data: Uint8Array): Reader {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, Math.min(offset + length, data.length)),
  };
}

export function blobReader(blob: Blob): Reader {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}
