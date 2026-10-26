import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { deletePaths, makeFolder, movePath, siteRow, tree } from "@/server/sites/store";
import { pathStr, siteId } from "../../_shared";

/** The draft's files and folders. */
export const GET = route({ auth: "admin" }, ({ params }) => {
  const id = siteId(params);
  siteRow(id);
  return tree(id);
});

const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mkdir"), path: pathStr }),
  z.object({ op: z.literal("move"), from: pathStr, to: pathStr }),
  z.object({ op: z.literal("delete"), paths: z.array(pathStr).min(1).max(2000) }),
]);

/** Make a folder, rename or move something, or delete files and folders. */
export const POST = route({ auth: "admin", body: op }, async ({ user, params, body, ip, zone }) => {
  const id = siteId(params);
  const site = siteRow(id);
  const change = body.op === "mkdir" ? await makeFolder(id, user, body.path) : body.op === "move" ? await movePath(id, user, body.from, body.to) : await deletePaths(id, user, body.paths);
  audit(user, { action: `sites.files.${body.op}`, target: site.name, summary: `${change.summary} in ${site.name}`, detail: { site: id, ...(body.op === "delete" ? { paths: body.paths.slice(0, 50) } : body) } }, { ip, zone });
  return change.tree;
});
