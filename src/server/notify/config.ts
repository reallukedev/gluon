import "server-only";
import { z } from "zod";
import { AppError } from "../errors";
import {
  channelConfigSchemas,
  MASK,
  type ChannelKind,
  type EmailConfig,
  type NtfyConfig,
  type PushoverConfig,
  type WebhookConfig,
} from "@/lib/alerts-types";

/**
 * Channel configuration: validation, secret masking and "keep the stored secret unless a new one was
 * typed" merging. Stored configs are the fully parsed objects, encrypted with encryptJson.
 */

export type StoredConfig = Record<string, unknown>;

const SECRET_FIELDS: Record<ChannelKind, string[]> = {
  ntfy: ["token", "password"],
  pushover: ["userKey", "appToken"],
  email: ["pass"],
  webhook: ["url"],
};

function maskValue(v: unknown, kind: ChannelKind, field: string): string | null {
  if (typeof v !== "string" || !v) return null;
  if (kind === "webhook" && field === "url") {
    try {
      const u = new URL(v);
      return `${u.origin}/${MASK}${v.length > 24 ? v.slice(-4) : ""}`;
    } catch {
      return MASK;
    }
  }
  return v.length >= 12 ? `${MASK}${v.slice(-4)}` : MASK;
}

const isMasked = (v: unknown) => typeof v === "string" && v.includes(MASK);

/** Config safe to send to the browser plus which secrets are set. */
export function maskConfig(kind: ChannelKind, cfg: StoredConfig): { config: Record<string, unknown>; secrets: Record<string, boolean> } {
  const out: Record<string, unknown> = { ...cfg };
  const secrets: Record<string, boolean> = {};
  for (const f of SECRET_FIELDS[kind]) {
    secrets[f] = typeof cfg[f] === "string" && !!cfg[f];
    out[f] = maskValue(cfg[f], kind, f);
  }
  if (kind === "webhook") {
    const headers = (cfg.headers as { name: string; value: string | null }[] | undefined) ?? [];
    out.headers = headers.map((h) => ({ name: h.name, value: h.value ? MASK : null }));
    secrets.headers = headers.some((h) => !!h.value);
  }
  return { config: out, secrets };
}

/** Where a channel delivers to. When any of these change, kept secrets would go to the new place. */
const DESTINATION_FIELDS: Record<ChannelKind, string[]> = {
  ntfy: ["server"],
  pushover: [],
  email: ["host", "port"],
  webhook: ["url"],
};

/**
 * Merge what the person typed over the stored config, keeping secrets they didn't retype. If the
 * destination changed, kept secrets are dropped instead: a token or password stored for one server
 * must never be sent to another one just because someone edited the address.
 */
export function mergeConfig(kind: ChannelKind, stored: StoredConfig | null, input: Record<string, unknown>): Record<string, unknown> {
  const merged = mergeKeeping(kind, stored, input);
  if (!stored) return merged;
  const moved = DESTINATION_FIELDS[kind].some((f) => {
    const v = input[f];
    if (v === undefined || isMasked(v)) return false;
    return String(v ?? "") !== String(stored[f] ?? "");
  });
  if (!moved) return merged;
  for (const f of SECRET_FIELDS[kind]) {
    const typed = input[f];
    if (typed === undefined || isMasked(typed)) merged[f] = null;
  }
  if (kind === "webhook" && Array.isArray(merged.headers)) {
    const typedHeaders = Array.isArray(input.headers) ? (input.headers as { value?: unknown }[]) : [];
    merged.headers = (merged.headers as { name: string; value: string | null }[]).map((h, i) => {
      const t = typedHeaders[i]?.value;
      return t === undefined || isMasked(t) ? { name: h.name, value: null } : h;
    });
  }
  return merged;
}

function mergeKeeping(kind: ChannelKind, stored: StoredConfig | null, input: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(stored ?? {}) };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (SECRET_FIELDS[kind].includes(k)) {
      if (isMasked(v)) continue; // unchanged
      base[k] = v === "" ? null : v;
      continue;
    }
    if (kind === "webhook" && k === "headers" && Array.isArray(v)) {
      const old = new Map(((stored?.headers as { name: string; value: string | null }[]) ?? []).map((h) => [h.name.toLowerCase(), h.value]));
      base.headers = v.map((h) => {
        const hh = (h ?? {}) as { name?: unknown; value?: unknown };
        const name = typeof hh.name === "string" ? hh.name : "";
        const value = hh.value === undefined || isMasked(hh.value) ? (old.get(name.toLowerCase()) ?? null) : hh.value === "" ? null : hh.value;
        return { name, value };
      });
      continue;
    }
    base[k] = v;
  }
  return base;
}

function zodFail(err: z.ZodError): never {
  const issue = err.issues[0];
  const field = issue?.path.join(".");
  const message = issue?.message && !issue.message.startsWith("Invalid") ? issue.message : `Check ${field || "the settings"}.`;
  throw new AppError("invalid", message, 400, field ? { field: `config.${field}` } : undefined);
}

const need = (ok: unknown, field: string, message: string) => {
  if (!ok) throw new AppError("invalid", message, 400, { field: `config.${field}` });
};

/** Parse + check the cross-field rules zod can't express nicely. */
export function validateConfig(kind: ChannelKind, merged: Record<string, unknown>): StoredConfig {
  const parsed = channelConfigSchemas[kind].safeParse(merged);
  if (!parsed.success) zodFail(parsed.error);
  const c = parsed.data as StoredConfig;
  switch (kind) {
    case "ntfy": {
      const n = c as unknown as NtfyConfig;
      if (n.username) need(n.password, "password", "Enter the password for that ntfy username.");
      if (n.password && !n.username) need(false, "username", "Enter the ntfy username that goes with the password.");
      break;
    }
    case "pushover": {
      const p = c as unknown as PushoverConfig;
      need(p.userKey && /^[A-Za-z0-9]{30}$/.test(p.userKey), "userKey", "Enter your Pushover user key (30 letters and numbers, on pushover.net after you sign in).");
      need(p.appToken && /^[A-Za-z0-9]{30}$/.test(p.appToken), "appToken", "Enter an application token (30 letters and numbers). Create one at pushover.net/apps/build.");
      break;
    }
    case "email": {
      const e = c as unknown as EmailConfig;
      if (!e.via) {
        need(e.host && /^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:.]+\]$/.test(e.host), "host", "Enter the mail server (SMTP) address, e.g. smtp.fastmail.com.");
        need(e.from || e.user, "from", "Enter the address messages come from.");
        if (e.user) need(e.pass, "pass", "Enter the mail server password (often an app password).");
      }
      if (e.from) need(/^[^\s<>@]+@[^\s<>@]+$|^.+<[^\s<>@]+@[^\s<>@]+>$/.test(e.from), "from", "The from address should look like gluon@example.com or Gluon <gluon@example.com>.");
      break;
    }
    case "webhook": {
      const w = c as unknown as WebhookConfig;
      need(w.url && /^https?:\/\/[^\s/]+/i.test(w.url), "url", "Enter the webhook address (starts with https://).");
      if (w.format === "discord") need(/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(w.url!), "url", "That isn't a Discord webhook address. In Discord: Channel settings → Integrations → Webhooks → Copy URL.");
      if (w.format === "slack") need(/^https:\/\/hooks\.slack\.com\//i.test(w.url!), "url", "That isn't a Slack webhook address (they start with https://hooks.slack.com/).");
      for (const h of w.headers) need(h.value, "headers", `Enter a value for the ${h.name} header.`);
      break;
    }
  }
  return c;
}

/** One line describing where messages go (no secrets). */
export function summarize(kind: ChannelKind, c: StoredConfig, viaName?: string | null): string {
  switch (kind) {
    case "ntfy": {
      const n = c as unknown as NtfyConfig;
      let host = n.server;
      try {
        host = new URL(n.server).host;
      } catch {
        /* keep */
      }
      return `${host} · ${n.topic}`;
    }
    case "pushover": {
      const p = c as unknown as PushoverConfig;
      return p.device ? `Pushover · ${p.device}` : "Pushover · all devices";
    }
    case "email": {
      const e = c as unknown as EmailConfig;
      const to = e.to.length === 1 ? e.to[0]! : `${e.to.length} addresses`;
      return e.via ? `${to} via ${viaName ?? "server mail"}` : `${to} via ${e.host}`;
    }
    case "webhook": {
      const w = c as unknown as WebhookConfig;
      const label = w.format === "discord" ? "Discord" : w.format === "slack" ? "Slack" : "Webhook";
      try {
        return `${label} · ${new URL(w.url ?? "").host}`;
      } catch {
        return label;
      }
    }
  }
}
