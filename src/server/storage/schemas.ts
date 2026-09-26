import "server-only";
import { z } from "zod";

const hostPathSchema = z
  .string()
  .trim()
  .min(1, "Choose a folder.")
  .max(4096)
  .refine((s) => s.startsWith("/") && !s.includes("\0"), "Use a full path starting with /.");
const device = z.string().trim().min(1, "Choose a drive.").max(256);

export const mountOp = z.object({ op: z.literal("mount"), device, target: hostPathSchema, readOnly: z.boolean().optional(), persist: z.boolean().optional(), noatime: z.boolean().optional() });
export const unmountOp = z.object({ op: z.literal("unmount"), target: hostPathSchema, removeFromFstab: z.boolean().optional() });
export const persistOp = z.object({ op: z.literal("persist"), targets: z.array(hostPathSchema).min(1).max(20).nullable().default(null), noatime: z.boolean().optional() });
export const renameOp = z.object({ op: z.literal("rename"), target: hostPathSchema, newPath: hostPathSchema, symlink: z.boolean().default(false), persist: z.boolean().default(true) });
export const setupOp = z.object({
  op: z.literal("setup"),
  disk: device,
  label: z.string().trim().min(1, "Give the drive a name.").max(16, "Use 16 characters or fewer for the name."),
  mountPath: hostPathSchema.optional(),
  noatime: z.boolean().optional(),
});
export const cleanupOp = z.discriminatedUnion("kind", [
  z.object({ op: z.literal("cleanup"), kind: z.literal("apt") }),
  z.object({ op: z.literal("cleanup"), kind: z.literal("journal"), keepBytes: z.number().int().min(50 * 1024 * 1024, "Keep at least 50 MB of logs.").max(100 * 1024 ** 3) }),
  z.object({
    op: z.literal("cleanup"),
    kind: z.literal("docker"),
    danglingImages: z.boolean().default(false),
    buildCache: z.boolean().default(false),
    containers: z.array(z.string().regex(/^[0-9a-f]{12,64}$/)).max(200).default([]),
    volumes: z.array(z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).max(200).default([]),
  }),
]);

/** POST /api/storage/plan — previews, nothing changes. */
export const planBody = z.discriminatedUnion("op", [mountOp, unmountOp, persistOp, renameOp, setupOp]);

/** POST /api/storage/operations — the real thing. rename/setup need the plan hash they were shown. */
export const operationBody = z.discriminatedUnion("op", [
  mountOp,
  unmountOp,
  persistOp,
  renameOp.extend({ planHash: z.string().min(8).max(64) }),
  setupOp.extend({ planHash: z.string().min(8).max(64), confirmSerial: z.string().trim().min(1, "Type the disk's serial number to confirm.").max(128) }),
  cleanupOp,
]);

export type OperationBody = z.infer<typeof operationBody>;
