import "server-only";
import os from "node:os";
import { z } from "zod";
import { one, run } from "./db";

/** Server-wide settings (admin). Each key has a schema and a default so reads never fail. */
const schemas = {
  /** Defaults to the machine's own hostname (Gluon shares the host's network, so it sees it). */
  serverName: z.string().min(1).max(40).default(() => (os.hostname().split(".")[0] || "server").slice(0, 40)),
  /** The public name Gluon is reached at from outside (e.g. gluon.example.com), or "" for none. */
  publicHost: z.string().max(253).default(""),
  baseDomain: z.string().max(253).default(""),
  homeNetworks: z.array(z.string().max(64)).max(32).default([]),
  requireMfaAway: z.boolean().default(true),
  sessionDays: z.number().int().min(1).max(90).default(30),
  /** Days of inactivity before a session used from outside home has to sign in again (≤ sessionDays). */
  awaySessionDays: z.number().int().min(1).max(90).default(7),
  householdCanSeeStatus: z.boolean().default(true),
  memberDefaultRoots: z.array(z.string()).default([]),
  weatherLocation: z
    .object({ name: z.string(), lat: z.number(), lon: z.number() })
    .nullable()
    .default(null),
  digest: z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23) }).default({ enabled: false, hour: 9 }),
  thresholds: z
    .object({
      diskAttention: z.number().min(50).max(99),
      diskFault: z.number().min(50).max(100),
      tempAttention: z.number().min(40).max(110),
      certDays: z.number().int().min(1).max(60),
      memoryAttention: z.number().min(50).max(100),
    })
    .default({ diskAttention: 85, diskFault: 95, tempAttention: 80, certDays: 14, memoryAttention: 92 }),
  /** Which home server OS Gluon works alongside: where apps are installed, updated and removed. */
  platform: z.enum(["auto", "umbrel", "casaos", "none"]).default("auto"),
  setupDone: z.boolean().default(false),
  /** Settings → Updates: automatic updates and where they come from. */
  updates: z
    .object({
      auto: z.boolean(),
      channel: z.enum(["releases", "main"]),
      hour: z.number().int().min(0).max(23),
      method: z.enum(["github", "umbrel", "casaos"]),
    })
    .default({ auto: false, channel: "releases", hour: 4, method: "github" }),
} as const;

export type SettingKey = keyof typeof schemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof schemas)[K]>;

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  const schema = schemas[key] as unknown as z.ZodType<SettingValue<K>>;
  if (!row) return schema.parse(undefined);
  const parsed = schema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : schema.parse(undefined);
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>) {
  const schema = schemas[key] as unknown as z.ZodType<SettingValue<K>>;
  const v = schema.parse(value);
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(v),
  );
  return v;
}

export function settingSchema<K extends SettingKey>(key: K) {
  return schemas[key];
}

/** Where links in notifications and invites point: the public name, else this server on the LAN. */
export function publicBaseUrl(): string {
  const host = getSetting("publicHost").trim();
  if (host) return `https://${host}`;
  return `http://${os.hostname()}:${process.env.PORT ?? "8130"}`;
}
