import { z } from "zod";
import { route } from "@/server/api";
import { searchStream } from "@/server/files/search";
import { flag, pathStr } from "../_schemas";
import { AppError } from "@/server/errors";
import type { FileKind } from "@/lib/files-types";

const KINDS: FileKind[] = ["image", "video", "audio", "document", "archive", "text", "disk-image"];

/** SSE over `path` or several `roots`: "hits" { items: SearchHit[] } batches, then "done" { count, truncated, timedOut }; "error" { message }. */
const query = z.object({
  path: pathStr.optional(),
  /** Several folders searched in one stream, as a JSON array (up to 20). */
  roots: z
    .string()
    .max(40_000)
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      try {
        const list = z.array(pathStr).min(1).max(20).parse(JSON.parse(v));
        return list;
      } catch {
        ctx.addIssue({ code: "custom", message: "Choose up to 20 folders to search." });
        return z.NEVER;
      }
    }),
  inPath: flag,
  q: z.string().min(1, "Type something to search for.").max(200),
  depth: z.coerce.number().int().min(1).max(40).optional(),
  type: z.enum(["file", "dir", "any"]).optional(),
  modifiedWithinDays: z.coerce.number().min(0).max(36500).optional(),
  minSize: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  /** Comma-separated kinds: image,video,audio,document,archive,text,disk-image. */
  kinds: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(",").filter((k): k is FileKind => KINDS.includes(k as FileKind)) : undefined)),
});

export const GET = route({ auth: "user", query }, ({ req, user, query }) => {
  const { path, roots, ...q } = query;
  const list = roots ?? (path ? [path] : []);
  if (!list.length) throw new AppError("bad_request", "Choose a folder to search.", 400);
  return searchStream(req, user, list, q);
});
