import { z } from "zod";
import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { normalizeHostPath } from "@/server/host/paths";
import { findHolders } from "@/server/storage/holders";
import { mountAt } from "@/server/storage/mounts";

/** GET /api/storage/holders?target=/mnt/hdd2 — processes and containers keeping a mount busy. */
export const GET = route({ auth: "admin", query: z.object({ target: z.string().min(1).max(4096).startsWith("/") }) }, async ({ query }) => {
  const target = normalizeHostPath(query.target);
  if (!mountAt(target)) throw notFound(`A mount at ${target}`);
  const { holders } = await findHolders(target);
  return { target, holders };
});
