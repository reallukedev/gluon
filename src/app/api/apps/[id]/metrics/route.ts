import { z } from "zod";
import { route } from "@/server/api";
import { getApp } from "@/server/docker/apps";
import { history } from "@/server/metrics/sampler";
import { notFound } from "@/server/errors";

const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;

/** Per-container CPU and memory history for one app. */
export const GET = route({ auth: "admin", query: z.object({ range: z.enum(["1h", "24h", "7d", "30d"]).default("24h") }) }, async ({ params, query }) => {
  const app = await getApp(decodeURIComponent(String(params.id)));
  if (!app) throw notFound("That app");
  const keys = app.containers.flatMap((c) => [`ctr.${c.name}.cpu`, `ctr.${c.name}.mem`]);
  return history(keys, RANGES[query.range]);
});
