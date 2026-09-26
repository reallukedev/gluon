import "server-only";
import { z } from "zod";
import { all, now, one, run } from "../db";
import { decryptJson, encryptJson, id as newId } from "../crypto";
import { AppError, badRequest, forbidden, notFound } from "../errors";
import type { User } from "../auth/users";
import { checkUrl } from "./net";
import { invalidate } from "./cache";
import { forgetImages } from "./image-refs";
import { kindDef, KINDS } from "./registry";
import type { KindContext } from "./kinds/base";
import type { Integration, IntegrationKind, IntegrationRef, IntegrationStatus, SecretState } from "@/lib/widgets-types";

interface Row {
  id: string;
  kind: string;
  name: string;
  base_url: string;
  config_enc: string;
  app_id: string | null;
  shared: number;
  created_at: number;
  updated_at: number;
}

/** Decrypted integration for server-side use only. */
export interface IntegrationRecord {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string;
  appId: string | null;
  shared: boolean;
  /** Validated config, or null when it can't be decrypted/validated any more. */
  config: Record<string, unknown> | null;
  configError: string | null;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------ status (in memory)

type G = typeof globalThis & { __gluonIntegrationStatus?: Map<string, IntegrationStatus> };
const g = globalThis as G;
const statuses = (g.__gluonIntegrationStatus ??= new Map());

export function noteStatus(id: string, ok: boolean, message: string | null) {
  statuses.set(id, { ok, message, checkedAt: Date.now() });
}
const statusOf = (id: string): IntegrationStatus => statuses.get(id) ?? { ok: null, message: null, checkedAt: null };

// ------------------------------------------------------------------ helpers

export const nameSchema = z.string().trim().min(1, "Give it a name.").max(60, "Keep the name under 60 characters.");
function parseName(v: string): string {
  const r = nameSchema.safeParse(v);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? "Check the name.", { field: "name" });
  return r.data;
}

/** Validate and tidy an app address. Generic JSON keeps its path and query; apps keep only a path prefix. */
export function normaliseBaseUrl(kind: IntegrationKind, raw: string): string {
  const u = checkUrl(raw.trim(), "trusted");
  u.hash = "";
  if (kind !== "generic-json") {
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  }
  return u.toString();
}

function hint(key: string, v: string): string | null {
  if (!/key|token/i.test(key) || v.length < 12) return null;
  return `••••${v.slice(-4)}`;
}

/** Split a config into what may be shown and the state of each secret. */
export function maskConfig(kind: IntegrationKind, config: Record<string, unknown> | null): { config: Record<string, unknown>; secrets: Record<string, SecretState> } {
  const def = KINDS[kind];
  const shown: Record<string, unknown> = { ...(config ?? {}) };
  const secrets: Record<string, SecretState> = {};
  for (const key of def.secretKeys) {
    const v = shown[key];
    if (Array.isArray(v)) {
      // Header lists: keep names, hide values.
      shown[key] = v.map((h) => ({ name: (h as { name?: string }).name ?? "", value: "" }));
      secrets[key] = { set: v.length > 0, hint: v.length ? `${v.length} header${v.length === 1 ? "" : "s"}` : null };
    } else {
      delete shown[key];
      const s = typeof v === "string" ? v : "";
      secrets[key] = { set: s.length > 0, hint: s ? hint(key, s) : null };
    }
  }
  return { config: shown, secrets };
}

/**
 * Apply an edit on top of the stored config. Secret fields that are missing or "" keep their stored value;
 * `null` clears them. Header values left "" keep the stored value for the same header name.
 */
export function mergeConfig(kind: IntegrationKind, prev: Record<string, unknown> | null, incoming: Record<string, unknown>): Record<string, unknown> {
  const def = KINDS[kind];
  const next: Record<string, unknown> = { ...(prev ?? {}), ...incoming };
  for (const key of def.secretKeys) {
    const inc = incoming[key];
    const old = prev?.[key];
    if (Array.isArray(inc)) {
      const oldList = Array.isArray(old) ? (old as { name: string; value: string }[]) : [];
      next[key] = inc.map((h) => {
        const hh = h as { name?: unknown; value?: unknown };
        const name = typeof hh.name === "string" ? hh.name : "";
        const value = typeof hh.value === "string" ? hh.value : "";
        if (value === "") {
          const kept = oldList.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
          if (kept) return { name, value: kept.value };
        }
        return { name, value };
      });
    } else if (inc === null) {
      next[key] = Array.isArray(old) ? [] : "";
    } else if (inc === undefined || inc === "") {
      if (old !== undefined) next[key] = old;
      else delete next[key];
    }
  }
  return next;
}

export function validateConfig(kind: IntegrationKind, config: Record<string, unknown>): Record<string, unknown> {
  const parsed = kindDef(kind).schema.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    const msg = issue?.message && !issue.message.startsWith("Invalid") ? issue.message : `Check ${field ?? "the settings"}.`;
    throw badRequest(msg, field ? { field: `config.${field}` } : undefined);
  }
  return parsed.data as Record<string, unknown>;
}

function toRecord(r: Row): IntegrationRecord {
  const kind = r.kind as IntegrationKind;
  let config: Record<string, unknown> | null = null;
  let configError: string | null = null;
  if (!KINDS[kind]) {
    configError = "Gluon no longer knows this kind of connection.";
  } else {
    try {
      const parsed = KINDS[kind].schema.safeParse(decryptJson<Record<string, unknown>>(r.config_enc));
      if (parsed.success) config = parsed.data as Record<string, unknown>;
      else configError = "The saved settings are incomplete. Open it and save again.";
    } catch {
      configError = "The saved credentials can't be read (Gluon's secret key changed). Enter them again.";
    }
  }
  return {
    id: r.id,
    kind,
    name: r.name,
    baseUrl: r.base_url,
    appId: r.app_id,
    shared: !!r.shared,
    config,
    configError,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAdminView(rec: IntegrationRecord): Integration {
  const { config, secrets } = maskConfig(rec.kind, rec.config);
  const status = rec.configError ? { ok: false, message: rec.configError, checkedAt: null } : statusOf(rec.id);
  return {
    id: rec.id,
    kind: rec.kind,
    name: rec.name,
    baseUrl: rec.baseUrl,
    appId: rec.appId,
    shared: rec.shared,
    config,
    secrets,
    widgets: KINDS[rec.kind]?.widgets ?? [],
    status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

// ------------------------------------------------------------------ queries

export function getRecord(id: string): IntegrationRecord | null {
  const r = one<Row>("SELECT * FROM integrations WHERE id = ?", id);
  return r ? toRecord(r) : null;
}

export function listRecords(): IntegrationRecord[] {
  return all<Row>("SELECT * FROM integrations ORDER BY name COLLATE NOCASE, created_at").map(toRecord);
}

export function listIntegrations(): Integration[] {
  return listRecords().map(toAdminView);
}

export function getIntegration(id: string): Integration {
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  return toAdminView(rec);
}

export function refOf(
  rec: IntegrationRecord,
  links: IntegrationRef["links"] = { home: null, away: null },
  app: { id: string; line: IntegrationRef["appLine"] } | null = null,
): IntegrationRef {
  return { id: rec.id, kind: rec.kind, name: rec.name, widgets: KINDS[rec.kind]?.widgets ?? [], links, appId: app?.id ?? rec.appId, appLine: app?.line ?? null };
}

/** Last known health of a saved connection (tests and widget fetches). */
export function statusFor(rec: IntegrationRecord): IntegrationStatus {
  return rec.configError ? { ok: false, message: rec.configError, checkedAt: null } : statusOf(rec.id);
}

/** Integrations this person may use in widgets. */
export function usableRecords(user: Pick<User, "role">): IntegrationRecord[] {
  return listRecords().filter((r) => r.config && (user.role === "admin" || r.shared));
}

/** Load an integration a person wants to read through (widgets, images). Members only get shared ones. */
export function readableRecord(user: Pick<User, "role">, id: string): IntegrationRecord {
  const rec = getRecord(id);
  if (!rec) throw notFound("That connected app");
  if (user.role !== "admin" && !rec.shared) throw forbidden("This widget uses a connected app your admin hasn't shared with the household.");
  if (!rec.config) throw new AppError("integration_broken", rec.configError ?? "This connection needs to be set up again.", 409);
  return rec;
}

export function contextFor(rec: IntegrationRecord): KindContext<Record<string, unknown>> {
  if (!rec.config) throw new AppError("integration_broken", rec.configError ?? "This connection needs to be set up again.", 409);
  return { id: rec.id, name: rec.name, baseUrl: rec.baseUrl, config: rec.config, version: rec.updatedAt };
}

// ------------------------------------------------------------------ mutations

export interface CreateInput {
  kind: IntegrationKind;
  name: string;
  baseUrl: string;
  config: Record<string, unknown>;
  appId?: string | null;
  shared?: boolean;
}

export function createIntegration(input: CreateInput): Integration {
  const name = parseName(input.name);
  const baseUrl = normaliseBaseUrl(input.kind, input.baseUrl);
  const config = validateConfig(input.kind, mergeConfig(input.kind, null, input.config));
  const id = newId();
  const t = now();
  run(
    `INSERT INTO integrations (id, kind, name, base_url, config_enc, app_id, shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.kind,
    name,
    baseUrl,
    encryptJson(config),
    input.appId ?? null,
    input.shared ? 1 : 0,
    t,
    t,
  );
  return getIntegration(id);
}

export interface UpdateInput {
  name?: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  appId?: string | null;
  shared?: boolean;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function updateIntegration(id: string, patch: UpdateInput): { before: Integration; after: Integration } {
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  const before = toAdminView(rec);
  const name = patch.name !== undefined ? parseName(patch.name) : rec.name;
  const baseUrl = patch.baseUrl !== undefined ? normaliseBaseUrl(rec.kind, patch.baseUrl) : rec.baseUrl;
  let configEnc: string | null = null;
  // Stored secrets (API keys, passwords) only ever go to the server they were entered for: pointing
  // a connection somewhere else means typing them again.
  const moved = !sameOrigin(baseUrl, rec.baseUrl);
  if (patch.config !== undefined || !rec.config || moved) {
    if (!rec.config && patch.config === undefined) throw badRequest(rec.configError ?? "Enter the settings again.");
    configEnc = encryptJson(validateConfig(rec.kind, mergeConfig(rec.kind, moved ? null : rec.config, patch.config ?? {})));
  }
  // updated_at doubles as the cache version, so it must strictly increase.
  const t = Math.max(now(), rec.updatedAt + 1);
  run(
    `UPDATE integrations SET name = ?, base_url = ?, config_enc = COALESCE(?, config_enc), app_id = ?, shared = ?, updated_at = ? WHERE id = ?`,
    name,
    baseUrl,
    configEnc,
    patch.appId !== undefined ? patch.appId : rec.appId,
    patch.shared !== undefined ? (patch.shared ? 1 : 0) : rec.shared ? 1 : 0,
    t,
    id,
  );
  invalidate(`int:${id}:`);
  if (baseUrl !== rec.baseUrl) forgetImages(id);
  statuses.delete(id);
  return { before, after: getIntegration(id) };
}

export function deleteIntegration(id: string): Integration {
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  run("DELETE FROM integrations WHERE id = ?", id);
  invalidate(`int:${id}:`);
  forgetImages(id);
  statuses.delete(id);
  return toAdminView(rec);
}

/** Build a context for testing: an unsaved config, or edits on top of a saved one (keeping stored secrets). */
export function testContext(input: { kind: IntegrationKind; baseUrl: string; config: Record<string, unknown>; id?: string }): KindContext<Record<string, unknown>> {
  let prev: Record<string, unknown> | null = null;
  if (input.id) {
    const rec = getRecord(input.id);
    if (!rec) throw notFound("That connection");
    if (rec.kind !== input.kind) throw badRequest("That connection is a different kind.");
    prev = rec.config;
  }
  const baseUrl = normaliseBaseUrl(input.kind, input.baseUrl);
  // Never send stored secrets to a different server than the one they were saved for.
  if (input.id && prev && !sameOrigin(baseUrl, getRecord(input.id)!.baseUrl)) prev = null;
  const config = validateConfig(input.kind, mergeConfig(input.kind, prev, input.config));
  return { id: input.id ?? null, name: "test", baseUrl, config, version: Date.now() };
}
