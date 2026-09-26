import "server-only";
import net from "node:net";
import { z } from "zod";

/**
 * Strict validation for anything that ends up as an argument to dig/ping/traceroute or a socket
 * connect. Hostnames: letters, digits, hyphens (underscores allowed for SRV/TXT-style labels), dots.
 * Never a leading "-" (would be read as an option).
 */

const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}\\.?$)(?:${LABEL}\\.)*${LABEL}\\.?$`);

/** Normalise a hostname or IP address; returns null when it isn't one. */
export function normalizeHost(input: string): string | null {
  let h = String(input ?? "").trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h || h.length > 253 || h.startsWith("-")) return null;
  if (net.isIP(h)) return h.toLowerCase();
  if (!HOSTNAME_RE.test(h)) return null;
  return h.toLowerCase().replace(/\.$/, "");
}

export const hostField = z
  .string()
  .max(255)
  .transform((v, ctx) => {
    const h = normalizeHost(v);
    if (!h) {
      ctx.addIssue({ code: "custom", message: "Enter a hostname like example.com or an IP address like 192.168.1.1." });
      return z.NEVER;
    }
    return h;
  });

export const portField = z.coerce
  .number()
  .int("Ports are whole numbers.")
  .min(1, "Ports go from 1 to 65535.")
  .max(65535, "Ports go from 1 to 65535.");

/** A resolver choice for DNS tools: a named public resolver, the system's, or an IP. */
export const RESOLVERS: Record<string, string | null> = {
  system: null,
  cloudflare: "1.1.1.1",
  google: "8.8.8.8",
  quad9: "9.9.9.9",
};

export const resolverField = z
  .string()
  .max(64)
  .default("system")
  .transform((v, ctx) => {
    const t = v.trim().toLowerCase();
    if (t in RESOLVERS) return t;
    if (net.isIP(t)) return t;
    ctx.addIssue({ code: "custom", message: "Pick a resolver from the list or enter its IP address." });
    return z.NEVER;
  });

export function resolverAddress(choice: string): string | null {
  return choice in RESOLVERS ? RESOLVERS[choice]! : choice;
}
