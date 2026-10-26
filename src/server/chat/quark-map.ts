import crypto from "node:crypto";
import { AppError } from "../errors";
import { capabilities } from "./capabilities";
import { clientName } from "./names";
import { XMPP_SENDER } from "../notify/xmpp-format";
import type { ChatAccount, ChatHostSnapshot, ChatInvite, ChatRoom, ChatSettings, ChatSnapshot } from "@/lib/chat-types";

/**
 * Quark's admin protocol (docs/admin-api.md in Quark's repository), the pure half: reading what
 * `quark ctl` prints, and turning its snapshot into the ChatSnapshot the Chat server tab shows.
 * Quark already speaks Gluon's shapes (settings, invites, milliseconds), so this is mostly
 * filling in what Gluon adds: owners from the config file, Gluon's sender account, the web side.
 */

// ---------------------------------------------------------------- wire shapes

/** Quark's settings: Gluon's, minus the "custom" history only Prosody's hand-written config can produce. */
export type QuarkSettings = Omit<ChatSettings, "history" | "calls"> & {
  history: Exclude<ChatSettings["history"], "custom">;
  calls: { on: boolean; host: string };
};

export interface QuarkInvite {
  token: string;
  username: string | null;
  role: "member" | "admin";
  created: number;
  expires: number;
  uri: string;
  page: string | null;
  reusable: boolean;
  reset: boolean;
}

export interface QuarkDevice {
  resource: string;
  client: string | null;
  ip: string | null;
  secure: boolean;
  since: number | null;
  resumable: boolean;
  inactive: boolean;
}

export interface QuarkHost {
  host: string;
  settings: QuarkSettings;
  admins: string[];
  accounts: { user: string; role: "member" | "admin"; enabled: boolean; created: number | null; passwordChanged: number | null; lastActive: number | null; devices: QuarkDevice[] }[];
  invites: QuarkInvite[];
  rooms: { jid: string; name: string | null; description: string | null; public: boolean; membersOnly: boolean; persistent: boolean; occupants: number }[];
  groupsHost: string | null;
  filesHost: string | null;
  modules: string[];
  requireEncryption: boolean;
  tls: { selfSigned: boolean; notAfter: number | null; issuer: string | null } | null;
}

export interface QuarkSnapshot {
  server: "quark";
  version: string;
  startedAt: number;
  configFile: string;
  certDir: string;
  hosts: QuarkHost[];
  turn: { builtIn: boolean; port: number; relayMin: number; relayMax: number; running: boolean };
  stats: { c2s: number; s2sIn: number; s2sOut: number; stanzasIn: number; stanzasOut: number };
}

export interface QuarkStatus {
  server: "quark";
  version: string;
  startedAt: number;
  configFile: string;
  dataDir: string;
}

// ---------------------------------------------------------------- `quark ctl` output

export type CtlResult = { kind: "ok"; value: unknown } | { kind: "refused"; code: string; error: string } | { kind: "unreachable"; detail: string };

/**
 * One JSON line on standard output: `{"ok":true,"value":…}` or `{"ok":false,"code":…,"error":…}`.
 * Quark exits 0 for both, and non-zero only when it couldn't reach the server, so a refusal still
 * counts even with a non-zero exit, and anything else is "couldn't reach Quark".
 */
export function parseCtl(stdout: string, stderr: string, exitCode: number | null): CtlResult {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // The last line that is an answer: anything logged before it is noise.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || typeof v !== "object" || typeof (v as { ok?: unknown }).ok !== "boolean") continue;
    const r = v as { ok: boolean; value?: unknown; code?: unknown; error?: unknown };
    if (r.ok) return { kind: "ok", value: r.value ?? null };
    return { kind: "refused", code: typeof r.code === "string" ? r.code : "internal", error: typeof r.error === "string" && r.error.trim() ? r.error.trim() : "Quark refused that." };
  }
  const detail = (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 300);
  return { kind: "unreachable", detail: detail || (exitCode === null ? "no answer" : `exit code ${exitCode}`) };
}

/** Quark's refusal as an AppError, its sentence shown as it is. */
export function refusalError(code: string, error: string): AppError {
  const status = code === "not_found" ? 404 : code === "exists" || code === "config" ? 409 : 400;
  return new AppError(code, error, status);
}

export function unreachableError(detail: string): AppError {
  return new AppError(
    "quark_console",
    `Couldn't reach Quark's admin console${detail ? ` (${detail})` : ""}. Check that Quark is running and finished starting, then try again.`,
    502,
  );
}

/** The value of a `quark ctl` answer, or the AppError that explains why there isn't one. */
export function ctlValue<T>(r: CtlResult): T {
  if (r.kind === "ok") return r.value as T;
  if (r.kind === "refused") throw refusalError(r.code, r.error);
  throw unreachableError(r.detail);
}

// ---------------------------------------------------------------- settings

const DEFAULT_HISTORY: QuarkSettings["history"] = "1w";

/**
 * Gluon's settings in Quark's shape. "custom" history can't come from Quark, but a page from before a
 * switch might still send it, so it keeps what Quark has; calls are filled in for old saves.
 */
export function toQuarkSettings(next: ChatSettings, current: ChatSettings, host: string): QuarkSettings {
  const history = next.history === "custom" ? (current.history === "custom" ? DEFAULT_HISTORY : current.history) : next.history;
  return { ...next, history, calls: next.calls ?? current.calls ?? { on: false, host } };
}

/** Changes whenever any domain's settings change, so a save from a stale page is refused. */
export function settingsRev(hosts: { host: string; settings: unknown }[]): string {
  const text = JSON.stringify(hosts.map((h) => [h.host, h.settings]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- snapshot

export function inviteFrom(i: QuarkInvite, host: string, publicBase: string | null): ChatInvite {
  return {
    token: i.token,
    username: i.username ?? null,
    role: i.role === "admin" ? "admin" : "member",
    created: i.created,
    expires: i.expires,
    uri: i.uri,
    // Quark's own page when its web side is on, else Gluon's, which asks Quark about the token.
    page: i.page ?? (publicBase ? `${publicBase.replace(/\/$/, "")}/chat-invite/${host}/${i.token}` : null),
    reusable: !!i.reusable,
    reset: !!i.reset,
  };
}

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

export function quarkHostSnapshot(h: QuarkHost, ctx: { webSide: boolean; publicBase: string | null }): ChatHostSnapshot {
  const admins = new Set(arr(h.admins).map((j) => j.toLowerCase()));
  const accounts: ChatAccount[] = arr(h.accounts)
    .map((a) => {
      const jid = `${a.user}@${h.host}`;
      const fromConfig = admins.has(jid);
      return {
        user: a.user,
        jid,
        role: fromConfig ? ("owner" as const) : a.role === "admin" ? ("admin" as const) : ("member" as const),
        roleName: a.role,
        fromConfig,
        sender: a.user === XMPP_SENDER,
        enabled: a.enabled !== false,
        created: a.created ?? null,
        passwordChanged: a.passwordChanged ?? null,
        lastActive: a.lastActive ?? null,
        devices: arr(a.devices)
          .map((d) => ({
            resource: d.resource,
            client: d.client ?? clientName(d.resource),
            ip: d.ip ?? null,
            secure: !!d.secure,
            since: d.since ?? null,
            resumable: !!d.resumable,
            inactive: !!d.inactive,
          }))
          .sort((x, y) => (y.since ?? 0) - (x.since ?? 0)),
      };
    })
    .sort((a, b) => a.user.localeCompare(b.user));

  const invites = arr(h.invites)
    .map((i) => inviteFrom(i, h.host, ctx.publicBase))
    .sort((a, b) => b.created - a.created);

  const rooms: ChatRoom[] = arr(h.rooms)
    .map((r) => ({ jid: r.jid, name: r.name ?? null, description: r.description ?? null, public: !!r.public, membersOnly: !!r.membersOnly, persistent: !!r.persistent, occupants: r.occupants ?? 0 }))
    .sort((a, b) => b.occupants - a.occupants || a.jid.localeCompare(b.jid));

  const modules = new Set(arr(h.modules));
  const settings: ChatSettings = { ...h.settings, calls: h.settings.calls ?? { on: false, host: h.host } };
  return {
    host: h.host,
    problem: null,
    accounts,
    invites,
    invitesReady: modules.has("invites") && modules.has("invites_register"),
    rooms,
    groupsHost: h.groupsHost ?? null,
    filesHost: h.filesHost ?? null,
    settings,
    // Quark has no hand-made components that outrank Gluon's settings.
    ownComponents: { muc: null, files: null },
    capabilities: capabilities({ host: h.host, modules, groupsHost: h.groupsHost ?? null, filesHost: h.filesHost ?? null, webSide: ctx.webSide, settings, requireEncryption: h.requireEncryption !== false, server: "quark" }),
    modules: [...modules].sort(),
  };
}

export function quarkSnapshot(
  raw: QuarkSnapshot,
  ctx: { app: { id: string; name: string }; container: string; route: { host: string; httpPort: number | null } | null; publicBase: string | null; now?: number },
): ChatSnapshot {
  const route = ctx.route;
  const hosts = arr(raw.hosts)
    .map((h) => quarkHostSnapshot(h, { webSide: !!route?.httpPort && route.host === h.host, publicBase: ctx.publicBase }))
    .sort((a, b) => Number(b.host === route?.host) - Number(a.host === route?.host) || b.accounts.length - a.accounts.length || a.host.localeCompare(b.host));
  return {
    app: ctx.app,
    server: "quark",
    container: ctx.container,
    version: raw.version,
    major: null,
    startedAt: raw.startedAt ?? null,
    hosts,
    routeHost: route?.host ?? null,
    // Gluon edits Quark's config through Quark (config.get / config.set), never the file itself.
    config: { file: raw.configFile ?? null, hostPath: null, writable: true, reason: null, managed: true, layout: "main", rev: settingsRev(arr(raw.hosts)) },
    publicBase: ctx.publicBase,
    builtInRelay: raw.turn ? { builtIn: !!raw.turn.builtIn, running: !!raw.turn.running, port: raw.turn.port, relayMin: raw.turn.relayMin, relayMax: raw.turn.relayMax } : null,
    checkedAt: ctx.now ?? Date.now(),
  };
}
