import "server-only";
import { z } from "zod";
import { client, obj, ok, runTest, str, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { cached, invalidate } from "../cache";
import { craftyError, sortServers, toServer, zoneOffset } from "./crafty-map";
import type { CraftyAction, CraftyServer, CraftyServersData } from "@/lib/widgets-types";

const USERNAME = /^[a-zA-Z0-9_-]{3,20}$/;

const schema = z
  .object({
    auth: z.enum(["key", "password"]).default("key"),
    apiKey: z.string().trim().max(4000).default(""),
    username: z.string().trim().max(20).default(""),
    password: z.string().max(200).default(""),
    allowSelfSigned: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.auth === "key") {
      // Crafty's API tokens are JWTs: three dot-separated parts.
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(c.apiKey)) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Paste the whole API token from Crafty. It's one long line with two dots in it." });
    } else {
      if (!USERNAME.test(c.username)) ctx.addIssue({ code: "custom", path: ["username"], message: "Crafty usernames are 3 to 20 letters, numbers, - or _." });
      if (c.password.length < 8) ctx.addIssue({ code: "custom", path: ["password"], message: "Enter the password for that Crafty user (Crafty passwords are at least 8 characters)." });
    }
  });
type Config = z.infer<typeof schema>;
type Ctx = KindContext<Config>;

const SERVER_ID = /^[a-z0-9-]{1,64}$/;
const MAX_SERVERS = 60;
const COMMAND: Record<CraftyAction, string> = { start: "start_server", stop: "stop_server", restart: "restart_server", kill: "kill_server" };

// ------------------------------------------------------------------ signing in

/**
 * Crafty's tokens are JWTs with no expiry: they stop working only when the user's tokens are revoked (password
 * change, "invalidate tokens") or the key is deleted. A token from a username and password is kept in memory per
 * connection version and fetched again once if Crafty refuses it. A failed sign-in is remembered for five minutes,
 * because Crafty locks an address out for five minutes after three wrong passwords in three minutes.
 */
type G = typeof globalThis & {
  __gluonCraftyTokens?: Map<string, string>;
  __gluonCraftyLoginFail?: Map<string, { at: number; error: UpstreamError }>;
  __gluonCraftyVersions?: Map<string, string>;
};
const g = globalThis as G;
const tokens = (g.__gluonCraftyTokens ??= new Map());
const loginFails = (g.__gluonCraftyLoginFail ??= new Map());
/** Last version each server reported while running, so a stopped server can still say what it runs. */
const lastVersions = (g.__gluonCraftyVersions ??= new Map());
const LOGIN_BACKOFF_MS = 5 * 60_000;

const tokenKey = (ctx: Ctx) => `${ctx.id ?? ctx.baseUrl}:${ctx.version}:${ctx.config.username.toLowerCase()}`;

function remember<K, V>(m: Map<K, V>, k: K, v: V, max = 64) {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as K);
}

function http(ctx: Ctx) {
  return client(def, ctx, () => null);
}


async function login(ctx: Ctx): Promise<string> {
  const k = tokenKey(ctx);
  const failed = loginFails.get(k);
  if (failed && Date.now() - failed.at < LOGIN_BACKOFF_MS) throw failed.error;
  const r = await http(ctx).raw("/api/v2/auth/login", {
    method: "POST",
    body: { username: ctx.config.username, password: ctx.config.password },
    noAuth: true,
    allow: [400, 401, 403, 429],
  });
  const text = r.body.toString("utf8");
  if (r.status >= 400) {
    const e = craftyError(text);
    let error: UpstreamError;
    if (r.status === 429 || e?.code === "TOO_MANY_ATTEMPTS") {
      error = new UpstreamError("Crafty is refusing sign-ins from Gluon for a few minutes after too many wrong passwords. Check the password, then try again in five minutes.", r.status, "upstream_auth");
    } else if (e?.code === "ACCOUNT_DISABLED") {
      error = new UpstreamError(`The Crafty user “${ctx.config.username}” is turned off. Turn it back on in Crafty under Users.`, r.status, "upstream_auth");
    } else if (e?.code === "PASSWORD_AUTH_DISABLED") {
      error = new UpstreamError(`“${ctx.config.username}” signs in to Crafty with a passkey only. Use an API token instead.`, r.status, "upstream_auth");
    } else {
      // Also what Crafty says when the account has two-step sign-in, which Gluon can't answer.
      error = new UpstreamError("Crafty didn't accept that username and password. If the account uses two-step sign-in, use an API token instead.", r.status, "upstream_auth");
    }
    remember(loginFails, k, { at: Date.now(), error });
    throw error;
  }
  let token: string | null = null;
  try {
    token = str(obj(obj(JSON.parse(text)).data).token);
  } catch {
    token = null;
  }
  if (!token) throw new UpstreamError("That address answered the sign-in, but not like Crafty does. Check the address points at Crafty.");
  loginFails.delete(k);
  remember(tokens, k, token);
  return token;
}

async function bearer(ctx: Ctx, fresh = false): Promise<string> {
  if (ctx.config.auth === "key") return ctx.config.apiKey;
  const cachedToken = fresh ? undefined : tokens.get(tokenKey(ctx));
  return cachedToken ?? login(ctx);
}

interface Answer {
  status: number;
  data: unknown;
  error: { code: string; detail: string } | null;
}

/**
 * One call to Crafty's API with the connection's token. Crafty answers 403 ACCESS_DENIED for a token it doesn't
 * accept (never 401) and 400 NOT_AUTHORIZED for a missing permission, so both come back here to be explained.
 */
async function call(ctx: Ctx, path: string, o: { method?: "GET" | "POST"; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Answer> {
  const once = async (token: string) => {
    const r = await http(ctx).raw(path, {
      method: o.method ?? "GET",
      headers: { Authorization: `Bearer ${token}` },
      noAuth: true,
      allow: [400, 403, 404],
      timeoutMs: o.timeoutMs ?? 6000,
      maxBytes: 4 * 1024 * 1024,
      signal: o.signal,
    });
    const text = r.body.toString("utf8");
    let data: unknown = null;
    try {
      data = obj(JSON.parse(text)).data ?? null;
    } catch {
      if (r.status < 300) {
        const html = /^\s*</.test(text);
        throw new UpstreamError(html ? "That address answered with a web page, not Crafty's API. Check the address and port (Crafty's is usually https on 8443)." : "Crafty answered with something Gluon couldn't read.", r.status);
      }
    }
    return { status: r.status, data, error: r.status >= 400 ? (craftyError(text) ?? { code: String(r.status), detail: "" }) : null };
  };
  let a = await once(await bearer(ctx));
  if (a.status === 403 && a.error?.code === "ACCESS_DENIED" && ctx.config.auth === "password" && !/mfa|otp|two/i.test(a.error.detail)) {
    // The kept token was revoked (password changed, tokens invalidated): sign in again, once.
    tokens.delete(tokenKey(ctx));
    a = await once(await bearer(ctx, true));
  }
  if (a.status === 403) {
    if (/mfa|otp/i.test(a.error?.detail ?? "")) {
      throw new UpstreamError("Crafty requires two-step sign-in for this account, which Gluon can't do. Use an API token instead: Crafty doesn't ask for two-step sign-in on those.", 403, "upstream_auth");
    }
    if (/disabled/i.test(a.error?.detail ?? "")) throw new UpstreamError("The Crafty user Gluon signs in as is turned off. Turn it back on in Crafty under Users.", 403, "upstream_auth");
    throw new UpstreamError(
      ctx.config.auth === "key" ? "Crafty didn't accept the API token. Check you copied all of it, or make a new one in Crafty (Panel Config → Users → the user → API Keys)." : "Crafty stopped accepting Gluon's sign-in. Check the username and password.",
      403,
      "upstream_auth",
    );
  }
  return a;
}

const isNotAuthorized = (a: Answer) => a.status === 400 && /NOT_AUTHORIZED/.test(a.error?.code ?? "");

// ------------------------------------------------------------------ reading servers

const key = (ctx: Ctx, what: string) => `int:${ctx.id ?? ctx.baseUrl}:${ctx.version}:crafty:${what}`;

async function craftyVersion(ctx: Ctx): Promise<string | null> {
  const r = await cached(key(ctx, "version"), 30 * 60_000, async () => {
    const a = await http(ctx).json<unknown>("/api/v2/", { noAuth: true, allow: [404] });
    return str(obj(obj(a).data).version);
  });
  return r.value;
}

async function listRaw(ctx: Ctx, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const a = await call(ctx, "/api/v2/servers", { signal });
  if (a.status === 404) throw new UpstreamError("That address answered, but it doesn't have Crafty's API. Check the address and port.", 404);
  if (a.status >= 400) throw new UpstreamError(`Crafty couldn't list its servers (${a.error?.code || a.status}).`, a.status);
  return (Array.isArray(a.data) ? (a.data as unknown[]) : [])
    .map(obj)
    .filter((s) => typeof s.server_id === "string" && SERVER_ID.test(s.server_id))
    .slice(0, MAX_SERVERS);
}

async function statsRaw(ctx: Ctx, id: string): Promise<Record<string, unknown> | null> {
  const a = await call(ctx, `/api/v2/servers/${id}/stats`).catch((e) => {
    if (e instanceof UpstreamError && e.code === "upstream_auth") throw e;
    return null;
  });
  // A brand-new server has no stats row yet; Crafty answers 500 for that one only.
  if (!a || a.status >= 400) return null;
  return obj(a.data);
}

function mapAll(rows: { item: Record<string, unknown>; stats: Record<string, unknown> | null }[]): CraftyServer[] {
  const now = Date.now();
  const offset = zoneOffset(
    rows.map((r) => r.stats?.created),
    now,
  );
  const out: CraftyServer[] = [];
  for (const r of rows) {
    const id = String(r.item.server_id);
    const s = toServer(r.item, r.stats, { now, offset, lastVersion: lastVersions.get(id) ?? null });
    if (!s) continue;
    if (s.players && s.version) remember(lastVersions, id, s.version, 500);
    out.push(s);
  }
  return sortServers(out);
}

async function allServers(ctx: Ctx): Promise<CraftyServer[]> {
  const r = await cached(key(ctx, "servers"), 4000, async () => {
    const list = await listRaw(ctx);
    const stats = await Promise.all(list.map((s) => statsRaw(ctx, String(s.server_id))));
    return mapAll(list.map((item, i) => ({ item, stats: stats[i] ?? null })));
  });
  return r.value;
}

async function servers(ctx: Ctx): Promise<CraftyServersData> {
  const [list, version] = await Promise.all([allServers(ctx), craftyVersion(ctx).catch(() => null)]);
  return { version, servers: list };
}

/** One server, read fresh from Crafty (for following an action until it settles). */
export async function serverNow(ctx: KindContext<Record<string, unknown>>, id: string): Promise<CraftyServer> {
  const c = ctx as unknown as Ctx;
  if (!SERVER_ID.test(id)) throw new UpstreamError("That isn't a Crafty server.", null, "bad_request");
  const list = await listRaw(c);
  const item = list.find((s) => s.server_id === id);
  if (!item) throw new UpstreamError("Crafty doesn't have that server any more, or Gluon's Crafty user can't see it.", 404, "not_found");
  const stats = await statsRaw(c, id);
  return mapAll([{ item, stats }])[0]!;
}

/** The server's name as Crafty knows it, for activity entries. */
export async function serverName(ctx: KindContext<Record<string, unknown>>, id: string): Promise<string | null> {
  const list = await allServers(ctx as unknown as Ctx).catch(() => [] as CraftyServer[]);
  return list.find((s) => s.id === id)?.name ?? null;
}

/** Ask Crafty to start, stop, restart or force-stop one server. Crafty queues the command and answers at once. */
export async function runAction(ctx: KindContext<Record<string, unknown>>, id: string, action: CraftyAction): Promise<void> {
  const c = ctx as unknown as Ctx;
  if (!SERVER_ID.test(id)) throw new UpstreamError("That isn't a Crafty server.", null, "bad_request");
  // The action name goes into the path; Crafty sends anything it doesn't recognise to the server console, so only
  // these four ever leave Gluon.
  const a = await call(c, `/api/v2/servers/${id}/action/${COMMAND[action]}`, { method: "POST", timeoutMs: 10_000 });
  if (isNotAuthorized(a)) {
    throw new UpstreamError(
      "Crafty says Gluon's user isn't allowed to do that on this server. In Crafty, give that user's role the Commands permission for it (Panel Config → Roles), and tick Commands on the API token too.",
      400,
      "upstream_forbidden",
    );
  }
  if (a.status === 404) throw new UpstreamError("Crafty doesn't have that server any more.", 404, "not_found");
  if (a.status >= 400) throw new UpstreamError(`Crafty refused (${a.error?.detail || a.error?.code || a.status}).`, a.status);
}

/** Drop what an action changed, so the next widget refresh asks Crafty again. */
export function forgetServers(ctx: KindContext<Record<string, unknown>>) {
  invalidate(`int:${ctx.id}:${ctx.version}:crafty:servers`);
  invalidate(`int:${ctx.id}:${ctx.version}:crafty.servers`);
}

// ------------------------------------------------------------------ search and links

/** Crafty's page for a server, when the address is one a browser could open too. */
function panelUrl(ctx: Ctx, id: string): string | undefined {
  try {
    const u = new URL(ctx.baseUrl);
    if (/^(127\.|localhost$|\[::1\]$|host\.docker\.internal$)/.test(u.hostname)) return undefined;
    return `${u.origin}/panel/server_detail?id=${encodeURIComponent(id)}`;
  } catch {
    return undefined;
  }
}

const STATE_WORD: Record<CraftyServer["state"], string> = {
  running: "running",
  starting: "starting",
  waiting: "waiting to start",
  updating: "updating",
  importing: "importing",
  stopped: "stopped",
  crashed: "crashed",
  unresponsive: "not answering",
  unknown: "state unknown",
};

async function search(ctx: Ctx, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const term = q.trim().toLowerCase();
  if (term.length < 2 || opts.limit < 1) return [];
  const list = await new Promise<CraftyServer[]>((resolve, reject) => {
    if (opts.signal.aborted) return reject(opts.signal.reason);
    const onAbort = () => reject(opts.signal.reason);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    allServers(ctx)
      .then(resolve, reject)
      .finally(() => opts.signal.removeEventListener("abort", onAbort));
  });
  return list
    .filter((s) => s.name.toLowerCase().includes(term) || (term.length >= 3 && s.players?.names.some((n) => n.toLowerCase() === term)))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)) || a.name.localeCompare(b.name))
    .slice(0, opts.limit)
    .map((s) => {
      const playing = s.players?.online ? ` · ${s.players.online} playing` : "";
      return { id: s.id, label: s.name, hint: `${s.game} server · ${STATE_WORD[s.state]}${playing}`, type: "game", url: panelUrl(ctx, s.id) };
    });
}

// ------------------------------------------------------------------ the kind

export const def: KindDef<Config> = {
  kind: "crafty",
  label: "Crafty Controller",
  noun: "Crafty",
  description: "Your Minecraft servers in Crafty Controller: who's playing, and start, stop or restart from Home.",
  baseUrlLabel: "Crafty address",
  baseUrlPlaceholder: "https://192.168.1.230:8443",
  keyHelp:
    "In Crafty, open Panel Config. Under Roles, add a role with your servers and the Commands permission ticked. Under Users, add a user for Gluon with that role. Then open the user's API Keys, create a token called “Gluon” with Commands ticked, press Get A Token and paste it here. A username and password also works, unless the account uses two-step sign-in. Crafty makes its own certificate, so for an https address turn on “Allow self-signed certificate”: Gluon then skips the certificate check for this connection only.",
  fields: [
    {
      key: "auth",
      label: "Sign in with",
      type: "select",
      required: true,
      secret: false,
      options: [
        { value: "key", label: "API token" },
        { value: "password", label: "Username and password" },
      ],
    },
    { key: "apiKey", label: "API token", type: "password", required: true, secret: true, showWhen: { key: "auth", in: ["key"] } },
    { key: "username", label: "Crafty username", type: "text", required: true, secret: false, showWhen: { key: "auth", in: ["password"] } },
    { key: "password", label: "Password", type: "password", required: true, secret: true, showWhen: { key: "auth", in: ["password"] } },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["apiKey", "password"],
  widgets: ["crafty.servers"],
  insecureTls: (c) => c.allowSelfSigned,
  test: (ctx) =>
    runTest(async () => {
      const h = http(ctx);
      const hello = await h.json<unknown>("/api/v2/", { noAuth: true, allow: [404] });
      const version = str(obj(obj(hello).data).version);
      if (!version) throw new UpstreamError("That address answered, but it doesn't look like Crafty Controller. Check the address and port (Crafty's is usually https on 8443).");
      const list = await listRaw(ctx);
      const n = list.length;
      const who = ctx.config.auth === "password" ? ` as “${ctx.config.username}”` : "";
      return ok(`Connected to Crafty ${version}${who}.`, {
        version,
        detail: n
          ? `Gluon can see ${n} ${n === 1 ? "server" : "servers"}.`
          : "Gluon can't see any servers. If Crafty has some, give Gluon's user a role with those servers (an API token on an admin account needs Full access ticked).",
      });
    }),
  data: {
    "crafty.servers": (ctx) => servers(ctx),
  },
  search: (ctx, q, opts) => search(ctx, q, opts),
};
