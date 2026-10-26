import { z } from "zod";

export const siteId = (params: Record<string, string | string[]>) => String(params.id ?? "");

export const pathStr = z.string().min(1, "Give it a name.").max(1000);

const hostname = z.string().trim().min(1, "Choose the address people will open.").max(253);

export const httpsSchema = z
  .object({
    mode: z.enum(["own", "http"]),
    files: z.object({ cert: z.string().max(400), key: z.string().max(400) }).optional(),
  })
  .nullable();

export const publishSchema = z.object({
  host: hostname.optional(),
  https: httpsSchema.optional(),
  certs: z.record(z.string().max(253), z.object({ cert: z.string().max(200_000), key: z.string().max(200_000) })).optional(),
});
