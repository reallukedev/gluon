// The icon folder's eviction rule, kept apart from the I/O so it can be tested.

export interface CacheFile {
  name: string;
  size: number;
  /** When it was fetched (its freshness). */
  mtime: number;
  /** When it was last served or written (its place in the LRU order). */
  used: number;
}

/** Keys to delete so the folder fits both caps, least recently used first; `keep` (the icon just written) stays. */
export function pickEvictions(files: ReadonlyMap<string, CacheFile>, caps: { maxFiles: number; maxBytes: number; keep?: string }): string[] {
  let count = files.size;
  let bytes = 0;
  for (const f of files.values()) bytes += f.size;
  if (count <= caps.maxFiles && bytes <= caps.maxBytes) return [];
  const order = [...files.entries()].filter(([k]) => k !== caps.keep).sort((a, b) => a[1].used - b[1].used);
  const out: string[] = [];
  for (const [k, f] of order) {
    if (count <= caps.maxFiles && bytes <= caps.maxBytes) break;
    out.push(k);
    count -= 1;
    bytes -= f.size;
  }
  return out;
}
