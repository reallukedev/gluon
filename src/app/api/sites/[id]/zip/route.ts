import fs from "node:fs";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { route } from "@/server/api";
import { disposition } from "@/server/files/stream";
import { draftDir, siteRow, walk } from "@/server/sites/store";
import { siteId } from "../../_shared";

/** The whole draft as a .zip, streamed. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const id = siteId(params);
  const site = siteRow(id);
  const { files, dirs } = walk(draftDir(id));
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (e) => archive.destroy(e));
  for (const d of dirs) archive.append("", { name: `${d}/`, type: "directory" } as Parameters<ZipArchive["append"]>[1]);
  for (const f of files) archive.append(fs.createReadStream(f.abs), { name: f.path, date: new Date(f.mtime) });
  void archive.finalize();
  const slug = site.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "site";
  return new Response(Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>, {
    headers: { "Content-Type": "application/zip", "Content-Disposition": disposition("attachment", `${slug}.zip`), "Cache-Control": "no-store" },
  });
});
