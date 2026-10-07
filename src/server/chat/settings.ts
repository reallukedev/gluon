import { luaString } from "./lua";
import { PROSODY_TURN_SECRET, TURN_PORT } from "./turn";
import type { ChatHostSnapshot, ChatSettings, HistoryKeep, SignUp } from "@/lib/chat-types";

/**
 * The chat settings Gluon manages live in their own file next to Prosody's config,
 * `gluon.cfg.lua`, pulled in by one Include line at the end of prosody.cfg.lua. Prosody reads
 * config top to bottom and a later value wins, and `Host "*"` returns to the global section, so
 * the file overrides what the main config says without Gluon rewriting the person's own file.
 *
 * Pure functions only: rendering, reading back, and the Include line.
 */

export const GLUON_CONFIG = "gluon.cfg.lua";
/** The person's own file in the conf.d layout. */
export const CUSTOM_FILE = "custom.lua";
/** Modules Gluon's settings turn on and off; after a reload Gluon loads or unloads these. */
export const MANAGED_MODULES = ["account_activity", "server_contact_info", "invites", "invites_register", "invites_adhoc", "mam", "cloud_notify", "s2s", "welcome", "bosh", "websocket", "turn_external"];
const INCLUDE = `Include "${GLUON_CONFIG}"`;
const SETTINGS_MARK = "-- gluon-settings:";

export const HISTORY: Record<Exclude<HistoryKeep, "off" | "custom">, { value: string; days: number }> = {
  // Spelled out: Prosody calls "1m" ambiguous (minute or month) and may stop accepting it.
  "1w": { value: "1 week", days: 7 },
  "1m": { value: "1 month", days: 30 },
  "3m": { value: "3 months", days: 91 },
  "1y": { value: "1 year", days: 365 },
  never: { value: "never", days: Infinity },
};

/** Prosody's duration strings: "1w", "3 months", "90d", a bare number of seconds, "never". */
export function durationDays(v: unknown): number | null {
  if (v === "never") return Infinity;
  if (typeof v === "number" && Number.isFinite(v)) return v / 86_400;
  if (typeof v !== "string") return null;
  const m = v.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const per: Record<string, number> = { "": 1 / 86_400, s: 1 / 86_400, d: 1, day: 1, days: 1, w: 7, week: 7, weeks: 7, m: 30, month: 30, months: 30, y: 365, year: 365, years: 365 };
  return unit in per ? n * per[unit]! : null;
}

export function historyFrom(mamOn: boolean, expires: unknown): HistoryKeep {
  if (!mamOn) return "off";
  // Prosody's default when unset is one week.
  const days = expires === undefined || expires === null ? 7 : durationDays(expires);
  if (days === null) return "custom";
  if (days === Infinity) return "never";
  for (const [k, h] of Object.entries(HISTORY)) if (h.days !== Infinity && Math.abs(h.days - days) <= Math.max(1, h.days * 0.05)) return k as HistoryKeep;
  return "custom";
}

export function signUpFrom(allow: unknown, inviteOnly: unknown, invitesRegister: boolean): SignUp {
  if (allow !== true) return "closed";
  // mod_invites_register makes sign-up invite-only unless told otherwise.
  if (invitesRegister && inviteOnly !== false) return "invite";
  return "open";
}

export interface RenderContext {
  /** The VirtualHost these settings are for. */
  host: string;
  /** Group chat and file sharing components declared in the person's own config (Gluon leaves them alone). */
  ownComponents: { muc: string | null; files: string | null };
  /** Gluon's public address, for invite links ("https://server.example.com"), when it has one. */
  publicBase: string | null;
  /**
   * "main": Gluon's file is included at the end of the person's prosody.cfg.lua. "confd": the
   * official image's own config includes Gluon's file (PROSODY_EXTRA_CONFIG), which includes the
   * person's custom.cfg.lua last, so their own settings win.
   */
  layout?: "main" | "confd";
  /** Where custom.cfg.lua is inside the container (confd layout). Includes resolve against the main config's folder, so it's absolute. */
  customPath?: string;
}

const q = luaString;

/** The whole of gluon.cfg.lua for these settings. */
export function renderGluonConfig(s: ChatSettings, ctx: RenderContext): string {
  const enable = new Set<string>(["account_activity", "server_contact_info"]);
  const disable = new Set<string>();
  const lines: string[] = [
    "-- Chat settings managed by Gluon (Apps, Prosody, Chat server).",
    "-- Gluon rewrites this file whenever those settings change.",
    ctx.layout === "confd"
      ? "-- Put your own settings in custom.cfg.lua, which is read after this file."
      : "-- Put your own settings in prosody.cfg.lua. A global setting here wins over the same one there; one set inside a VirtualHost there still wins.",
    `${SETTINGS_MARK} ${JSON.stringify(s)}`,
    "",
    'Host "*"',
  ];

  lines.push(`allow_registration = ${s.signUp !== "closed"}`);
  if (s.signUp !== "closed") {
    lines.push(`registration_invite_only = ${s.signUp === "invite"}`);
  }
  // "invite" also lets members make invite links in their chat app (Gluon's work in every mode).
  lines.push(`allow_user_invites = ${s.signUp === "invite"}`);
  // Invites work in every mode, even with sign-up off: they're how someone you invite picks
  // their own password.
  for (const m of ["invites", "invites_register", "invites_adhoc"]) enable.add(m);
  if (ctx.publicBase) lines.push(`invites_page = ${q(`${ctx.publicBase}/chat-invite/{host}/{invite.token}`)}`);

  if (s.history === "off") disable.add("mam");
  else {
    enable.add("mam");
    if (s.history !== "custom") lines.push(`archive_expires_after = ${q(HISTORY[s.history].value)}`);
  }

  // Off means off, even when the person's own modules_enabled lists it.
  if (s.push) enable.add("cloud_notify");
  else disable.add("cloud_notify");
  if (!s.federation) disable.add("s2s");

  if (s.welcome?.trim()) {
    enable.add("welcome");
    lines.push(`welcome_message = ${q(s.welcome.trim())}`);
  }
  const contacts = s.contact?.trim() ? [s.contact.trim().includes(":") ? s.contact.trim() : `xmpp:${s.contact.trim()}`] : [];
  if (contacts.length) lines.push(`contact_info = { admin = { ${contacts.map(q).join("; ")} } }`);

  if (s.calls?.on) {
    enable.add("turn_external");
    lines.push(`turn_external_host = ${q(s.calls.host)}`, `turn_external_port = ${TURN_PORT}`);
    // The secret stays out of the config: it sits in Prosody's data folder, readable only by
    // Prosody. A missing file leaves calls without a relay rather than stopping Prosody.
    lines.push(`do local f = Lua.io.open(${q(PROSODY_TURN_SECRET)}, "r"); if f then turn_external_secret = f:read("*l"); f:close() end end`);
  } else disable.add("turn_external");

  if (s.web) {
    enable.add("bosh");
    enable.add("websocket");
  } else {
    disable.add("bosh");
    disable.add("websocket");
  }
  if (s.web || (s.files.on && !ctx.ownComponents.files)) {
    // Browsers and uploads reach the chat server through the chat domain's web address: Caddy
    // holds the certificate and passes X-Forwarded-Proto. Only Docker's bridge networks (where
    // Caddy's requests come from) are trusted to say a request was HTTPS, never the home network,
    // so a device on the LAN talking plain HTTP to the web port can't sign in.
    lines.push(`http_external_url = ${q(`https://${ctx.host}/`)}`);
    lines.push('trusted_proxies = { "127.0.0.1"; "::1"; "172.16.0.0/12" }');
    // Prosody 13 serves HTTP on loopback only, which inside a container nothing else can reach.
    lines.push('http_interfaces = { "*"; "::" }');
  }

  // Either list may be missing or set to nil (the official image does that to modules_disabled).
  const list = (name: string, items: Set<string>) => {
    const v = `{ ${[...items].map(q).join("; ")} }`;
    return `if ${name} then ${name}:append ${v} else ${name} = ${v} end`;
  };
  lines.push(list("modules_enabled", enable));
  if (disable.size) lines.push(list("modules_disabled", disable));

  if (s.groups.on && !ctx.ownComponents.muc) {
    lines.push(
      "",
      `Component ${q(s.groups.host)} "muc"`,
      `\tname = ${q(`Group chats on ${ctx.host}`)}`,
      `\tmodules_enabled = { ${s.history === "off" ? "" : '"muc_mam"; '}"muc_unique" }`,
      // mod_muc takes true (admins only) or "local" (anyone on this server); anything else means anyone at all.
      `\trestrict_room_creation = ${s.groups.whoCreates === "admins" ? "true" : '"local"'}`,
      "\tmuc_room_default_persistent = true",
      "\tmuc_room_default_public = false",
    );
  }
  if (s.files.on && !ctx.ownComponents.files) {
    lines.push(
      "",
      `Component ${q(s.files.host)} "http_file_share"`,
      `\thttp_host = ${q(ctx.host)}`,
      `\thttp_file_share_size_limit = ${Math.round(s.files.maxMb * 1024 * 1024)}`,
      `\thttp_file_share_expires_after = ${s.files.keepDays > 0 ? `${s.files.keepDays} * 86400` : "-1"}`,
    );
  }
  if (ctx.layout === "confd") lines.push("", "-- Yours, read last so it wins.", 'Host "*"', `Include ${q(ctx.customPath ?? `/etc/prosody/conf.d/${CUSTOM_FILE}`)}`);
  return lines.join("\n") + "\n";
}

/** The settings Gluon last wrote, read back from the marker line, or null. */
export function readGluonConfig(text: string | null): ChatSettings | null {
  if (!text) return null;
  const line = text.split("\n").find((l) => l.startsWith(SETTINGS_MARK));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(SETTINGS_MARK.length)) as ChatSettings;
  } catch {
    return null;
  }
}

/** The main config with Gluon's Include line at the very end (or unchanged if it's there). */
export function withInclude(main: string): { text: string; changed: boolean } {
  if (hasInclude(main)) return { text: main, changed: false };
  const body = main.replace(/\s*$/, "");
  return {
    text: `${body}\n\n-- Chat settings Gluon manages. Keep this line last so they apply to every host.\n${INCLUDE}\n`,
    changed: true,
  };
}

export function hasInclude(main: string): boolean {
  return main.split("\n").some((l) => {
    const t = l.trim();
    return !t.startsWith("--") && /^Include\s*\(?\s*["']gluon\.cfg\.lua["']\s*\)?\s*;?$/.test(t);
  });
}

/** Components a settings change adds or removes; Prosody only picks those up on a restart. */
export function componentChange(before: ChatSettings, after: ChatSettings, own: ChatHostSnapshot["ownComponents"]): string[] {
  const out: string[] = [];
  if (!own.muc && (before.groups.on !== after.groups.on || (after.groups.on && before.groups.host !== after.groups.host))) out.push(after.groups.on ? "group chats" : "removing group chats");
  if (!own.files && (before.files.on !== after.files.on || (after.files.on && before.files.host !== after.files.host))) out.push(after.files.on ? "file sharing" : "removing file sharing");
  // The web port's interfaces are only read at startup.
  const web = (x: ChatSettings) => x.web || (x.files.on && !own.files);
  if (web(before) !== web(after) && !out.some((x) => x.includes("file sharing"))) out.push(web(after) ? "web chat" : "turning off web chat");
  return out;
}
