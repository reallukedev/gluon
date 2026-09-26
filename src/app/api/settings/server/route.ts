import { z } from "zod";
import net from "node:net";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { getSetting, setSetting } from "@/server/settings";
import { audit } from "@/server/audit";
import { hasRecentAuth } from "@/server/auth/session";
import { localIpv6Prefixes, resetZoneCache } from "@/server/net-zone";

const cidr = z.string().max(64).refine((v) => {
  const [addr, bits] = v.split("/");
  if (!addr) return false;
  const fam = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
  if (!fam) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (fam === 4 ? 32 : 128);
}, "Use an address range like 192.168.50.0/24").refine((v) => {
  // Anything wider than a /8 (IPv4) or /32 (IPv6) would make a large part of the internet "home".
  const [addr, bits] = v.split("/");
  if (bits === undefined) return true;
  return Number(bits) >= (net.isIPv4(addr ?? "") ? 8 : 32);
}, "That range is too wide: it would treat much of the internet as home.");

const body = z.object({
  serverName: z.string().trim().min(1, "Give the server a name.").max(40).optional(),
  publicHost: z.string().trim().max(253).regex(/^$|^[a-z0-9.-]+$/i, "Use a plain hostname, like home.example.com").optional(),
  homeNetworks: z.array(cidr).max(32).optional(),
  requireMfaAway: z.boolean().optional(),
  sessionDays: z.number().int().min(1).max(90).optional(),
  awaySessionDays: z.number().int().min(1).max(90).optional(),
  householdCanSeeStatus: z.boolean().optional(),
  thresholds: z
    .object({
      diskAttention: z.number().min(50).max(99),
      diskFault: z.number().min(50).max(100),
      tempAttention: z.number().min(40).max(110),
      certDays: z.number().int().min(1).max(60),
      memoryAttention: z.number().min(50).max(100),
    })
    .optional(),
});

function current() {
  return {
    serverName: getSetting("serverName"),
    publicHost: getSetting("publicHost"),
    baseDomain: getSetting("baseDomain"),
    homeNetworks: getSetting("homeNetworks"),
    detectedPrefixes: localIpv6Prefixes().map((p) => `${p}/64`),
    requireMfaAway: getSetting("requireMfaAway"),
    sessionDays: getSetting("sessionDays"),
    awaySessionDays: getSetting("awaySessionDays"),
    householdCanSeeStatus: getSetting("householdCanSeeStatus"),
    thresholds: getSetting("thresholds"),
  };
}

export const GET = route({ auth: "admin" }, () => current());

/** Settings that decide who counts as "home" and how sign-in works: changing them needs a fresh confirm. */
const SECURITY_KEYS = ["homeNetworks", "requireMfaAway", "sessionDays", "awaySessionDays", "publicHost"] as const;

export const PATCH = route({ auth: "admin", body }, ({ body, user, session, ip, zone }) => {
  const now = current();
  const touchesSecurity = SECURITY_KEYS.some((k) => body[k] !== undefined && JSON.stringify(body[k]) !== JSON.stringify(now[k]));
  if (touchesSecurity && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const changed: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    setSetting(k as never, v as never);
    changed.push(k);
  }
  if (changed.includes("homeNetworks")) resetZoneCache();
  if (changed.length) audit(user, { action: "settings.server", summary: `Changed server settings (${changed.join(", ")})`, detail: body }, { ip, zone });
  return current();
});
