import "server-only";
import { z } from "zod";
import { ENV_NAME_RE, SERVICE_RE, SLUG_RE, MAX_ICON_BYTES, BRANCH_RE } from "@/lib/builder/names";

/**
 * Request shapes. Drafts may be incomplete or wrong (that's what the checks are for), so these
 * bound sizes and types; the publish step runs the full checks.
 */

const text = (max: number) => z.string().max(max, `Keep it under ${max.toLocaleString("en")} characters.`);
const port = z.number().int().min(1).max(65535).nullable();

export const detailsSchema = z.object({
  name: text(200),
  slug: z.string().regex(SLUG_RE, "Use lowercase letters, digits and - for the id."),
  tagline: text(300),
  description: text(10_000),
  category: text(40),
  icon: z
    .string()
    .max(Math.ceil(MAX_ICON_BYTES * 1.4) + 100, "That icon is too big. Use one under 256 KB.")
    .refine((v) => /^(https?:\/\/|data:image\/(png|jpeg|webp|gif|svg\+xml)(;base64)?,)/.test(v), "Icons are an https:// address or an uploaded image.")
    .nullable(),
  website: text(2048),
  support: text(2048),
  developer: text(200),
  version: text(64),
  releaseNotes: text(4000),
});

export const webSchema = z.object({
  service: z.string().regex(SERVICE_RE).nullable(),
  containerPort: port,
  port,
  path: text(300).refine((p) => !p || (p.startsWith("/") && !/[\s"'<>\\]/.test(p)), "The path starts with / and has no spaces."),
  umbrelAuth: z.boolean(),
});

export const specSchema = z.object({
  details: detailsSchema,
  web: webSchema,
  compose: z.string().max(256 * 1024, "The compose file is too large (256 KB at most)."),
});

const envKey = z.string().regex(ENV_NAME_RE, "Variable names use letters, digits and _.").max(128);
const envVal = z.string().max(32_768).refine((v) => !v.includes("\0"));
const svcName = z.string().regex(SERVICE_RE, "That isn't a service name.");

export const secretsOps = z.object({
  set: z.record(svcName, z.record(envKey, envVal)).optional(),
  remove: z.record(svcName, z.array(envKey).max(200)).optional(),
  renameService: z.object({ from: svcName, to: svcName }).optional(),
});

const tokenSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9_\-.]+$/, "That doesn't look like a GitHub token.")
  .nullable();

export const githubRefSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  branch: z.string().regex(BRANCH_RE, "That isn't a branch name Gluon can use."),
  path: z.string().max(300),
  private: z.boolean(),
});

export const createSchema = z.object({
  source: z.enum(["image", "compose", "github"]),
  spec: specSchema,
  secrets: z.record(svcName, z.record(envKey, envVal)).optional(),
  github: githubRefSchema.nullable().optional(),
  token: tokenSchema.optional(),
});

export const patchSchema = z.object({
  rev: z.number().int().min(0),
  spec: specSchema,
  secrets: secretsOps.optional(),
  github: z.object({ branch: z.string().regex(BRANCH_RE, "That isn't a branch name Gluon can use."), path: z.string().max(300) }).optional(),
  token: tokenSchema.optional(),
});

export const inspectSchema = z.object({
  repo: z.string().min(1, "Enter a repository, like owner/name.").max(300),
  branch: z.string().max(200).optional(),
  path: z.string().max(300).optional(),
  token: tokenSchema.optional(),
  /** Inspect an existing app's repository with its stored token. */
  app: z.string().max(40).optional(),
});
