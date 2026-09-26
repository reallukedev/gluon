import { z } from "zod";
import { route } from "@/server/api";
import { history } from "@/server/metrics/sampler";

const RANGES = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 } as const;

const query = z.object({
  keys: z.string().max(2000).transform((s) => s.split(",").map((k) => k.trim()).filter((k) => /^[\w./:@-]{1,160}$/.test(k)).slice(0, 24)),
  range: z.enum(["1h", "6h", "24h", "7d", "30d", "90d"]).default("24h"),
});

export const GET = route({ auth: "user", query }, ({ query, user }) => {
  const keys = user.role === "admin" ? query.keys : query.keys.filter((k) => !k.startsWith("ctr."));
  return history(keys, RANGES[query.range]);
});
