import { z } from "zod";

/** Shared zod pieces for the Files API. */
export const pathStr = z.string().min(1, "Choose a folder or file.").max(4096);
export const flag = z
  .enum(["0", "1", "true", "false", ""])
  .optional()
  .transform((v) => v === "1" || v === "true");
export const policy = z.enum(["rename", "overwrite", "skip"]);
export const where = (ctx: { ip: string; zone: string }) => ({ ip: ctx.ip, zone: ctx.zone });
