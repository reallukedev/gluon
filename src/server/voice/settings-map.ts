import type { SettingKind, VoiceSetting } from "./types";

/**
 * The Mumble settings Gluon shows, and where each value comes from. Pure: no Ice, no Docker.
 *
 * Mumble reads its config file (which the official image writes from MUMBLE_CONFIG_* variables)
 * as the default for every virtual server, and per-server values saved in its database (what Ice
 * setConf writes) win over it. Clearing a saved value falls back to the file again, so an empty
 * value can't switch off something the compose file turns on (a join password, for one).
 */

export interface SettingDef {
  /** The key Ice getConf/setConf uses. */
  key: string;
  /** The config file key, which MUMBLE_CONFIG_<name> maps to. */
  iniKey: string;
  label: string;
  help: string;
  kind: SettingKind;
  /** Mumble's own default when neither the database nor the config file says. */
  builtin: string;
  unit?: string;
  min?: number;
  max?: number;
  scale?: number;
}

export const SETTINGS: SettingDef[] = [
  { key: "registername", iniKey: "registerName", label: "Server name", help: "Shown at the top of the channel list, and in Mumble's public server list if you add it there.", kind: "text", builtin: "" },
  { key: "welcometext", iniKey: "welcometext", label: "Welcome message", help: "What people see in the chat when they join. Mumble shows simple HTML: bold, italics, links and line breaks.", kind: "richtext", builtin: "" },
  { key: "password", iniKey: "serverpassword", label: "Join password", help: "Everyone without a registered name needs this to join.", kind: "secret", builtin: "" },
  { key: "users", iniKey: "users", label: "Most people at once", help: "New people can't join once this many are connected.", kind: "number", builtin: "100", min: 1, max: 5000 },
  { key: "usersperchannel", iniKey: "usersperchannel", label: "Most people per channel", help: "0 means no limit.", kind: "number", builtin: "0", min: 0, max: 5000 },
  { key: "bandwidth", iniKey: "bandwidth", label: "Sound quality per person", help: "The most each person may send. Mumble's default, 558 kbit/s, is plenty; lower it on a slow upload.", kind: "number", builtin: "558000", unit: "kbit/s", min: 8, max: 1000, scale: 1000 },
  { key: "textmessagelength", iniKey: "textmessagelength", label: "Longest text message", help: "In characters. 0 means no limit.", kind: "number", builtin: "5000", unit: "characters", min: 0, max: 1_000_000 },
  { key: "imagemessagelength", iniKey: "imagemessagelength", label: "Largest picture in a message", help: "Pictures pasted into the chat. 0 means no limit.", kind: "number", builtin: "131072", unit: "KB", min: 0, max: 100_000, scale: 1024 },
  { key: "allowhtml", iniKey: "allowhtml", label: "Allow formatting in messages", help: "Lets people use bold, links and pictures in chat messages and comments.", kind: "bool", builtin: "true" },
  { key: "rememberchannel", iniKey: "rememberchannel", label: "Remember each person's channel", help: "Registered people come back to the channel they left from.", kind: "bool", builtin: "true" },
  { key: "allowrecording", iniKey: "allowRecording", label: "Allow recording", help: "Mumble apps can record the conversation. Everyone sees when someone records.", kind: "bool", builtin: "true" },
  { key: "certrequired", iniKey: "certrequired", label: "Only people with a certificate", help: "Keeps out clients that don't send a certificate. Mumble apps make one on first start.", kind: "bool", builtin: "false" },
];

export const settingDef = (key: string) => SETTINGS.find((s) => s.key === key) ?? null;

const norm = (s: string) => s.toUpperCase().replace(/_/g, "");

/** The MUMBLE_CONFIG_* variable that sets `iniKey`, the way the image's entrypoint matches them. */
export function envFor(iniKey: string, env: Record<string, string>): { name: string; value: string } | null {
  const want = norm(iniKey);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("MUMBLE_CONFIG_") && norm(name.slice("MUMBLE_CONFIG_".length)) === want) return { name, value };
  }
  return null;
}

/** Container env as a map (later entries win, as Docker does). */
export function envMap(list: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of list ?? []) {
    const i = e.indexOf("=");
    if (i > 0) out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

/** The image's entrypoint writes values as-is, so a quoted value keeps its quotes. Mumble's QSettings strips them. */
const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

export function effectiveSettings(input: { db: Record<string, string>; defaults: Record<string, string>; env: Record<string, string> }): VoiceSetting[] {
  return SETTINGS.map((d) => {
    const env = envFor(d.iniKey, input.env);
    const saved = input.db[d.key];
    const fromDb = saved !== undefined && saved.trim() !== "";
    const fallback = input.defaults[d.key] ?? (env ? unquote(env.value) : d.builtin);
    const value = fromDb ? saved : fallback;
    return {
      key: d.key,
      label: d.label,
      help: d.help,
      kind: d.kind,
      value: d.kind === "bool" ? String(asBool(value)) : value,
      source: fromDb ? "gluon" : env ? "compose" : "default",
      envName: env?.name ?? null,
      envValue: env ? unquote(env.value) : null,
      fallback: d.kind === "bool" ? String(asBool(fallback)) : fallback,
      unit: d.unit,
      min: d.min,
      max: d.max,
      scale: d.scale,
    };
  });
}

export function asBool(v: string): boolean {
  return /^(true|1|yes|on)$/i.test(v.trim());
}

/**
 * Turn what the person typed into the value Ice stores, or say what's wrong. Numbers arrive in
 * the unit shown (kbit/s, KB) and are stored in Mumble's (bit/s, bytes).
 */
export function toStored(d: SettingDef, raw: string): { ok: true; value: string } | { ok: false; message: string } {
  if (d.kind === "bool") {
    if (!/^(true|false)$/.test(raw)) return { ok: false, message: "Choose on or off." };
    return { ok: true, value: raw };
  }
  if (d.kind === "number") {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return { ok: false, message: "Use a whole number." };
    const n = Number(t);
    if (d.min !== undefined && n < d.min) return { ok: false, message: `Use ${d.min.toLocaleString("en")} or more.` };
    if (d.max !== undefined && n > d.max) return { ok: false, message: `Use ${d.max.toLocaleString("en")} or less.` };
    return { ok: true, value: String(n * (d.scale ?? 1)) };
  }
  if (raw.includes("\0")) return { ok: false, message: "That has a character Mumble can't store." };
  const max = d.kind === "richtext" ? 20_000 : 200;
  if (raw.length > max) return { ok: false, message: `Keep it under ${max.toLocaleString("en")} characters.` };
  if (d.kind === "text" || d.kind === "secret") {
    if (/[\r\n]/.test(raw)) return { ok: false, message: "Keep it on one line." };
  }
  return { ok: true, value: raw };
}

/** The number to show for a stored value (bit/s to kbit/s, bytes to KB). */
export function toShown(d: Pick<SettingDef, "scale">, stored: string): string {
  const n = Number(stored);
  if (!d.scale || !Number.isFinite(n)) return stored;
  return String(Math.round(n / d.scale));
}
