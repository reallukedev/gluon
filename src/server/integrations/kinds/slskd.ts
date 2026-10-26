import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { matchScore, prepare } from "@/lib/search-match";
import type { SlskdTransfer, SlskdTransfersData } from "@/lib/widgets-types";

const schema = z
  .object({
    username: z.string().trim().max(100).default(""),
    password: z.string().max(200).default(""),
    /** Connections made before slskd sign-in used an API key; they keep working. */
    apiKey: z.string().trim().max(256).optional(),
    allowSelfSigned: z.boolean().default(false),
  })
  .refine((c) => (c.username && c.password) || c.apiKey, { message: "Enter slskd's username and password.", path: ["username"] });
type Config = z.infer<typeof schema>;

/**
 * slskd signs its web UI in at /api/v0/session and hands back a JWT; Gluon does the same, keeps the
 * token in memory per connection version, and signs in again a minute before it expires or after a 401.
 */
type G = typeof globalThis & { __gluonSlskdTokens?: Map<string, { token: string; exp: number }> };
const g = globalThis as G;
const tokens = (g.__gluonSlskdTokens ??= new Map());
const tokenKey = (ctx: KindContext<Config>) => `${ctx.id ?? ctx.baseUrl}:${ctx.version}:${ctx.config.username}`;

function http(ctx: KindContext<Config>) {
  return client(def, ctx, (status) =>
    status === 401
      ? ctx.config.apiKey && !ctx.config.username
        ? "slskd answered 401: the API key is wrong. Reconnect with slskd's username and password."
        : "slskd didn't accept that username and password."
      : "slskd answered 403: this account isn't allowed to read transfers.",
  );
}

async function login(ctx: KindContext<Config>): Promise<string> {
  const r = await http(ctx).raw("/api/v0/session", {
    method: "POST",
    body: { username: ctx.config.username, password: ctx.config.password },
    noAuth: true,
    allow: [400, 401, 403],
  });
  if (r.status >= 400) throw new UpstreamError("slskd didn't accept that username and password.", r.status, "upstream_auth");
  let res: Record<string, unknown>;
  try {
    res = obj(JSON.parse(r.body.toString("utf8")));
  } catch {
    throw new UpstreamError("slskd answered the sign-in with something Gluon couldn't read.");
  }
  const token = str(res.token);
  if (!token) throw new UpstreamError("slskd didn't hand out a sign-in token.");
  const expires = num(res.expires);
  const exp = expires ? (expires > 1e12 ? expires : expires * 1000) : Date.now() + 3600_000;
  tokens.set(tokenKey(ctx), { token, exp: Math.max(Date.now() + 60_000, exp - 60_000) });
  return token;
}

/** GET JSON, signing in again once if slskd has forgotten the token (it restarted, or it expired early). */
async function get<T = unknown>(ctx: KindContext<Config>, path: string, opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  try {
    return await http(ctx).json<T>(path, opts);
  } catch (e) {
    if (e instanceof UpstreamError && e.upstreamStatus === 401 && ctx.config.username) {
      tokens.delete(tokenKey(ctx));
      return http(ctx).json<T>(path, opts);
    }
    throw e;
  }
}

/** .NET TimeSpan "1.02:03:04.5" / "00:01:23.456" → seconds. */
function timespan(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function stateOf(s: string): SlskdTransfer["state"] {
  if (/InProgress|Initializing/i.test(s)) return "active";
  if (/Queued|Requested/i.test(s)) return "queued";
  if (/Succeeded/i.test(s)) return "done";
  if (/Completed/i.test(s)) return "failed";
  return "queued";
}

function flatten(users: unknown, direction: SlskdTransfer["direction"]): (SlskdTransfer & { endedAt: number | null })[] {
  const out: (SlskdTransfer & { endedAt: number | null })[] = [];
  for (const u of arr<Record<string, unknown>>(users)) {
    for (const d of arr<Record<string, unknown>>(u.directories)) {
      for (const f of arr<Record<string, unknown>>(d.files)) {
        const label = str(f.state) ?? "Unknown";
        const parts = String(f.filename ?? "").split(/[\\/]/).filter(Boolean);
        const size = num(f.size) ?? 0;
        const done = num(f.bytesTransferred) ?? 0;
        const state = stateOf(label);
        out.push({
          id: String(f.id ?? `${u.username}:${f.filename}`),
          direction,
          user: String(f.username ?? u.username ?? ""),
          file: parts[parts.length - 1] ?? "file",
          folder: parts.length > 1 ? parts[parts.length - 2]! : null,
          sizeBytes: size,
          transferredBytes: done,
          percent: Math.max(0, Math.min(100, num(f.percentComplete) ?? (size ? (done / size) * 100 : 0))),
          speedBps: state === "active" ? num(f.averageSpeed) : null,
          state,
          stateLabel: label,
          placeInQueue: num(f.placeInQueue),
          remainingSec: state === "active" ? timespan(f.remainingTime) : null,
          endedAt: time(f.endedAt),
        });
      }
    }
  }
  return out;
}

async function transfers(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<SlskdTransfersData> {
  const limit = Math.min(50, Math.max(1, Number(params.limit ?? 8)));
  const [down, up, app] = await Promise.all([
    get(ctx, "/api/v0/transfers/downloads", { maxBytes: 16 * 1024 * 1024 }),
    get(ctx, "/api/v0/transfers/uploads", { maxBytes: 16 * 1024 * 1024 }),
    get(ctx, "/api/v0/application").catch(() => null),
  ]);
  const downloads = flatten(down, "download");
  const uploads = flatten(up, "upload");
  const all = [...downloads, ...uploads];
  const dayAgo = Date.now() - 24 * 3600_000;
  const rank = { active: 0, queued: 1, failed: 2, done: 3 } as const;
  const shown = all
    .filter((t) => t.state === "active" || t.state === "queued" || (t.endedAt ?? 0) > dayAgo)
    .sort(
      (a, b) =>
        rank[a.state] - rank[b.state] ||
        (a.state === "active" ? b.percent - a.percent : 0) ||
        (a.state === "queued" ? (a.placeInQueue ?? 1e9) - (b.placeInQueue ?? 1e9) : 0) ||
        (b.endedAt ?? 0) - (a.endedAt ?? 0),
    )
    .slice(0, limit)
    .map(({ endedAt: _e, ...t }) => t);
  const speed = (list: SlskdTransfer[]) => list.filter((t) => t.state === "active").reduce((s, t) => s + (t.speedBps ?? 0), 0);
  const a = app ? obj(app) : null;
  const server = a ? obj(a.server) : null;
  return {
    connected: server ? server.isLoggedIn === true || server.isConnected === true : null,
    username: a ? (str(obj(a.user).username) ?? str(server?.username)) : null,
    downloads: {
      active: downloads.filter((t) => t.state === "active").length,
      queued: downloads.filter((t) => t.state === "queued").length,
      failed: downloads.filter((t) => t.state === "failed" && (t.endedAt ?? 0) > dayAgo).length,
      speedBps: speed(downloads),
    },
    uploads: {
      active: uploads.filter((t) => t.state === "active").length,
      queued: uploads.filter((t) => t.state === "queued").length,
      speedBps: speed(uploads),
    },
    items: shown,
  };
}

// ------------------------------------------------------------------ universal search

const STATE_WORD: Record<SlskdTransfer["state"], string> = { active: "Downloading", queued: "Queued", done: "Downloaded", failed: "Didn't finish" };

/**
 * Only what slskd already has: files it downloaded (or is downloading) and searches someone ran
 * before. Never starts a Soulseek search, which would go out to the network.
 */
export function searchHits(ctx: KindContext<Config>, downloads: unknown, searches: unknown, q: string, limit: number): KindSearchHit[] {
  const query = prepare(q);
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const out: { hit: KindSearchHit; score: number; i: number }[] = [];
  const seen = new Set<string>();
  flatten(downloads, "download").forEach((t, i) => {
    const score = matchScore(query, { label: t.file, keywords: t.folder ?? "", hint: t.user });
    const key = `${t.folder}/${t.file}`;
    if (score < 0.4 || seen.has(key)) return;
    seen.add(key);
    out.push({ i, score, hit: { id: `dl:${t.id}`, label: t.file, hint: [STATE_WORD[t.state], t.folder, `from ${t.user}`].filter(Boolean).join(" · "), url: `${base}/downloads`, type: "download" } });
  });
  arr<Record<string, unknown>>(searches).forEach((x, i) => {
    const text = str(x.searchText);
    const id = str(x.id);
    if (!text || !id) return;
    const score = matchScore(query, { label: text });
    if (score < 0.5) return;
    const files = num(x.fileCount);
    out.push({ i: 10_000 + i, score: score * 0.95, hit: { id: `search:${id}`, label: text, hint: ["Earlier search", files !== null ? `${files} file${files === 1 ? "" : "s"} found` : null].filter(Boolean).join(" · "), url: `${base}/searches/${encodeURIComponent(id)}`, type: "search" } });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((x) => x.hit);
}

async function search(ctx: KindContext<Config>, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const [downloads, searches] = await Promise.all([
    get(ctx, "/api/v0/transfers/downloads", { maxBytes: 16 * 1024 * 1024, signal: opts.signal, timeoutMs: 1800 }),
    get(ctx, "/api/v0/searches", { signal: opts.signal, timeoutMs: 1800 }).catch(() => []),
  ]);
  if (opts.signal.aborted) return [];
  return searchHits(ctx, downloads, searches, q, opts.limit);
}

export const def: KindDef<Config> = {
  kind: "slskd",
  label: "slskd",
  description: "Soulseek downloads and uploads in progress, with progress and speed.",
  baseUrlLabel: "slskd address",
  baseUrlPlaceholder: "http://127.0.0.1:5030",
  keyHelp: "Use the username and password you sign in to slskd's web page with (web → authentication in slskd's settings; the default is slskd / slskd).",
  fields: [
    { key: "username", label: "Username", type: "text", required: true, secret: false },
    { key: "password", label: "Password", type: "password", required: true, secret: true },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["password", "apiKey"],
  widgets: ["slskd.transfers"],
  insecureTls: (c) => c.allowSelfSigned,
  async authorize(ctx, req) {
    if (!ctx.config.username && ctx.config.apiKey) {
      req.headers["X-API-Key"] = ctx.config.apiKey;
      return;
    }
    const cached = tokens.get(tokenKey(ctx));
    const token = cached && cached.exp > Date.now() ? cached.token : await login(ctx);
    req.headers.Authorization = `Bearer ${token}`;
  },
  test: (ctx) =>
    runTest(async () => {
      const app = obj(await get(ctx, "/api/v0/application"));
      const v = obj(app.version);
      const version = str(v.current) ?? str(v.full) ?? str(app.version);
      const server = obj(app.server);
      const user = str(obj(app.user).username) ?? str(server.username);
      const connected = server.isLoggedIn === true || server.isConnected === true;
      await get(ctx, "/api/v0/transfers/downloads", { maxBytes: 16 * 1024 * 1024 });
      return ok(
        connected
          ? `Connected to slskd${version ? ` ${version}` : ""}${user ? `; signed in to Soulseek as “${user}”` : ""}.`
          : `Connected to slskd${version ? ` ${version}` : ""}, but it isn't connected to the Soulseek network right now.`,
        { version, serverName: user },
      );
    }),
  data: {
    "slskd.transfers": (ctx, p) => transfers(ctx, p),
  },
  search,
};
