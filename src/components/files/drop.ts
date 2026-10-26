"use client";

/** A file picked or dropped for upload, with its folder path relative to the drop ("" at the top). */
export interface Incoming {
  file: File;
  rel: string;
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (list: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

async function walk(entry: FsEntry, rel: string, out: Incoming[], dirs: string[]) {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ file: f, rel });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const here = rel ? `${rel}/${entry.name}` : entry.name;
    dirs.push(here);
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call; keep reading until it returns none.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walk(child, here, out, dirs);
    }
  }
}

/**
 * Everything in a desktop drop, including the contents of dropped folders. Must be called
 * synchronously from the drop handler (the DataTransfer is only readable during the event).
 */
export function readDrop(dt: DataTransfer): Promise<{ files: Incoming[]; dirs: string[] }> {
  const entries: FsEntry[] = [];
  const loose: File[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== "file") continue;
    const e = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  return (async () => {
    const files: Incoming[] = loose.map((f) => ({ file: f, rel: "" }));
    const dirs: string[] = [];
    for (const e of entries) await walk(e, "", files, dirs);
    return { files, dirs };
  })();
}

/** Files from an <input type="file" webkitdirectory> (webkitRelativePath = "Folder/sub/file"). */
export function fromInput(list: FileList | null): { files: Incoming[]; dirs: string[] } {
  const files: Incoming[] = [];
  const dirs = new Set<string>();
  for (const f of [...(list ?? [])]) {
    const rp = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const rel = rp.includes("/") ? rp.slice(0, rp.lastIndexOf("/")) : "";
    files.push({ file: f, rel });
    if (rel) {
      const parts = rel.split("/");
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return { files, dirs: [...dirs] };
}
