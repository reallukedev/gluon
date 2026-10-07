import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { parseTarget } from "@/lib/terminal/types";
import { containerNames, listDir, listUnits, resolveTarget } from "@/server/terminal/targets";

const query = z.object({
  target: z.string().max(140),
  kind: z.enum(["paths", "units", "containers"]),
  dir: z.string().max(1024).optional(),
});

/** Suggestions that need the target: a folder's contents, systemd units, container names. */
export const GET = route({ auth: "admin", query, burst: { limit: 240, windowMs: 60_000 } }, async ({ query }) => {
  const target = parseTarget(query.target);
  if (!target) throw new AppError("invalid", "That isn't a place commands can run.", 400);
  if (query.kind === "paths") {
    const dir = query.dir ?? "";
    if (!dir.startsWith("/") || dir.includes("\0")) throw new AppError("invalid", "The folder must be an absolute path.", 400);
    return { entries: await listDir(await resolveTarget(target), dir) };
  }
  // Units and containers belong to the server itself, not to what runs inside a container.
  if (target !== "host") return query.kind === "units" ? { units: [] } : { containers: [] };
  if (query.kind === "units") return { units: await listUnits() };
  return { containers: await containerNames() };
});
