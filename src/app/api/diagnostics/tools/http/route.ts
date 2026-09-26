import { z } from "zod";
import { route } from "@/server/api";
import { httpRequest } from "@/server/diagnostics/tools";
import { normalizeHost } from "@/server/diagnostics/validate";

const body = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => {
      try {
        const u = new URL(v);
        return (u.protocol === "http:" || u.protocol === "https:") && !!normalizeHost(u.hostname);
      } catch {
        return false;
      }
    }, "Enter a full address starting with http:// or https://."),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  followRedirects: z.boolean().default(true),
  /** Don't fail on untrusted/self-signed certificates. */
  insecure: z.boolean().default(false),
});

/** HTTP request from the server with a timing breakdown, headers and the first 4 KB of the body. */
export const POST = route({ auth: "admin", body }, ({ body }) => httpRequest(body.url, body.method, body.followRedirects, body.insecure));
