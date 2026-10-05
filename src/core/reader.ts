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

/**
 * Serves small reads from a few cached windows. Repair does thousands of
 * 5-byte header reads in mostly ascending order; in a browser each uncached
 * Blob read is a separate async round trip.
 */
export function cachedReader(inner: Reader, windowSize = 1 << 20, maxWindows = 4): Reader {
  const windows = new Map<number, Promise<Uint8Array>>();
  const windowAt = (index: number): Promise<Uint8Array> => {
    let w = windows.get(index);
    if (w) {
      windows.delete(index); // re-insert as most recently used
    } else {
      w = inner.read(index * windowSize, windowSize);
      if (windows.size >= maxWindows) windows.delete(windows.keys().next().value!);
    }
    windows.set(index, w);
    return w;
  };
  return {
    size: inner.size,
    async read(offset, length) {
      const first = Math.floor(offset / windowSize);
      const last = Math.floor((offset + length - 1) / windowSize);
      if (length > windowSize || last - first > 1) return inner.read(offset, length);
      const start = offset - first * windowSize;
      const a = await windowAt(first);
      if (first === last) return a.subarray(start, start + length);
      const b = await windowAt(last);
      const out = new Uint8Array(Math.min(length, a.length - start + b.length));
      out.set(a.subarray(start));
      out.set(b.subarray(0, out.length - (a.length - start)), a.length - start);
      return out;
    },
  };
}
