import { z } from "zod";
import { route } from "@/server/api";
import { listDir } from "@/server/files/list";
import { flag, pathStr } from "../_schemas";

const query = z.object({
  path: pathStr,
  sort: z.enum(["name", "size", "mtime", "kind", "type"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  hidden: flag,
  foldersFirst: z.enum(["0", "1", "true", "false"]).optional(),
  filter: z.string().max(200).optional(),
  only: z.enum(["dirs"]).optional(),
});

export const GET = route({ auth: "user", query }, ({ user, query }) =>
  listDir(user, {
    path: query.path,
    sort: query.sort,
    order: query.order,
    offset: query.offset,
    limit: query.limit,
    hidden: query.hidden,
    filter: query.filter,
    foldersFirst: query.foldersFirst === undefined ? undefined : query.foldersFirst === "1" || query.foldersFirst === "true",
    only: query.only,
  }),
);
