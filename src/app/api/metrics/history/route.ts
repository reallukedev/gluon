import { z } from "zod";
import { route } from "@/server/api";
import { history } from "@/server/metrics/sampler";
import { getSetting } from "@/server/settings";

const RANGES = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 } as const;

const query = z.object({
  keys: z.string().max(2000).transform((s) => s.split(",").map((k) => k.trim()).filter((k) => /^[\w./:@-]{1,160}$/.test(k)).slice(0, 24)),
  range: z.enum(["1h", "6h", "24h", "7d", "30d", "90d"]).default("24h"),
});

/** Machine-wide numbers a household member may chart, and only when the household can see status. */
const MEMBER_KEYS = new Set(["cpu", "mem.used", "load1", "net.rx", "net.tx", "disk.read", "disk.write", "temp.cpu"]);

export const GET = route({ auth: "user", query }, ({ query, user }) => {
  // Members never get per-container or per-mount series: those name host paths and apps.
  const keys = user.role === "admin" ? query.keys : getSetting("householdCanSeeStatus") ? query.keys.filter((k) => MEMBER_KEYS.has(k)) : [];
  return history(keys, RANGES[query.range]);
});
