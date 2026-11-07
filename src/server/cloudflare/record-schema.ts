import { z } from "zod";
import { EDITABLE_TYPES } from "@/lib/cloudflare-types";

/** What the DNS editor sends; records.ts does the real checking. */
export const recordBody = z.object({
  type: z.enum(EDITABLE_TYPES),
  name: z.string().max(253),
  content: z.string().max(2048),
  proxied: z.boolean().default(false),
  ttl: z.number().int().default(1),
  priority: z.number().int().nullable().optional(),
  comment: z.string().max(200).nullable().optional(),
});
