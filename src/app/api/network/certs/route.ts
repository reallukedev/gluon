import { z } from "zod";
import { route } from "@/server/api";
import { previewCert } from "@/server/network/own-certs";

const host = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/, "That isn't a host name.");
const path = z.string().max(400);

const body = z.union([
  z.object({ host, cert: z.string().max(65_536), key: z.string().max(65_536) }),
  z.object({ host, files: z.object({ cert: path, key: path }) }),
]);

/**
 * Check a certificate for an address before saving: pasted text, or files on this server. Stores
 * nothing and returns only what's safe to show (names, issuer, dates, fingerprint), never the key.
 */
export const POST = route({ auth: "admin", body, burst: { limit: 30, windowMs: 60_000 } }, ({ body }) => ({ info: previewCert(body.host, "files" in body ? { files: body.files } : { cert: body.cert, key: body.key }) }));
