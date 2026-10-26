import "server-only";
import fs from "node:fs";
import type { User } from "../auth/users";
import { AppError } from "../errors";
import { formatBytes } from "@/lib/format";
import { SITE_LIMITS, type SiteImportResult } from "@/lib/sites-types";
import { checkRoom, clashIn, mkTemp, placeAll, resolveDraft, touched, withSite } from "./store";
import { extractEntry, planZip } from "./zip";
import { starterFiles } from "./starter";

/** Read a request body into memory, refusing past `max` bytes without buffering the rest. */
export async function readBody(body: ReadableStream<Uint8Array> | null, max: number, what: string): Promise<Buffer> {
  if (!body) throw new AppError("empty", `The ${what} was empty.`, 400);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("too_large", `The ${what} is over ${formatBytes(max)}, the most Gluon takes at once.`, 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Unpack a .zip into the draft (or a folder of it). Everything is checked and extracted to a work
 * folder first; only then do the files move into the draft, replacing ones with the same name.
 */
export async function importZip(id: string, user: Pick<User, "username">, zip: Buffer, into: string): Promise<SiteImportResult> {
  const plan = await planZip(zip);
  if (!plan.entries.length) throw new AppError("empty_zip", plan.skipped.length ? `Nothing in that zip can go on a site: ${plan.skipped[0]!.reason}` : "That zip is empty.", 400);
  const items: { rel: string; tmp: string; mtime?: number }[] = [];
  try {
    let bytes = 0;
    for (const e of plan.entries) {
      const tmp = mkTemp(id);
      items.push({ rel: into ? `${into}/${e.rel}` : e.rel, tmp, mtime: e.file.lastModifiedDateTime?.getTime?.() || undefined });
      bytes += await extractEntry(e.file, tmp);
      if (bytes > SITE_LIMITS.siteBytes) throw new AppError("site_too_large", `This zip unpacks to more than ${formatBytes(SITE_LIMITS.siteBytes)}, the most a site can hold.`, 413);
    }
    return await withSite(id, () => {
      // Every clash is found before anything moves (placeAll checks again, and undoes itself if the disk still says no).
      const clash = clashIn(id, items.map((it) => it.rel));
      if (clash) throw new AppError("exists", clash, 409);
      let addFiles = 0;
      let addBytes = 0;
      for (const it of items) {
        const { st } = resolveDraft(id, it.rel);
        const size = fs.statSync(it.tmp).size;
        if (!st) addFiles++;
        addBytes += size - (st?.isFile() ? st.size : 0);
      }
      checkRoom(id, addFiles, addBytes);
      const { added, replaced } = placeAll(id, items);
      return { added, replaced, skipped: plan.skipped, tree: touched(id, user) };
    });
  } finally {
    for (const it of items) fs.rmSync(it.tmp, { force: true });
  }
}

/** The starter page: a few small files that look finished and are easy to change. */
export function addStarter(id: string, user: Pick<User, "username">, name: string) {
  return withSite(id, () => {
    const items = starterFiles(name).map((f) => {
      const tmp = mkTemp(id);
      fs.writeFileSync(tmp, f.text, { mode: 0o644, flag: "wx" });
      return { rel: f.path, tmp };
    });
    placeAll(id, items);
    return touched(id, user);
  });
}
