import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { matchScore, prepare } from "@/lib/search-match";
import { bucketWidth, imageUrl } from "../image-refs";
import type { SubsonicNowPlayingData, SubsonicRecentData } from "@/lib/widgets-types";

const schema = z
  .object({
    auth: z.enum(["password", "token", "apiKey"]).default("password"),
    username: z.string().trim().max(100).default(""),
    password: z.string().max(200).default(""),
    token: z.string().trim().max(128).default(""),
    salt: z.string().trim().max(128).default(""),
    apiKey: z.string().trim().max(256).default(""),
    allowSelfSigned: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.auth !== "apiKey" && !c.username) ctx.addIssue({ code: "custom", path: ["username"], message: "Enter the username." });
    if (c.auth === "password" && !c.password) ctx.addIssue({ code: "custom", path: ["password"], message: "Enter the password." });
    if (c.auth === "token") {
      if (!/^[a-f0-9]{32}$/i.test(c.token)) ctx.addIssue({ code: "custom", path: ["token"], message: "The token is 32 hex characters (md5 of password + salt)." });
      if (!c.salt) ctx.addIssue({ code: "custom", path: ["salt"], message: "Enter the salt used to make the token." });
    }
    if (c.auth === "apiKey" && !c.apiKey) ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Paste the API key." });
  });
type Config = z.infer<typeof schema>;

const ERRORS: Record<number, string> = {
  10: "a required parameter was missing",
  20: "Gluon's client is too new for this server",
  30: "this server is too new for Gluon's client",
  40: "the username or password is wrong",
  41: "this account can't use token sign-in (common with LDAP users); use an API key or a local account",
  42: "this server doesn't support that way of signing in; try another in the settings",
  43: "more than one way of signing in was sent",
  44: "the API key is wrong",
  50: "this account isn't allowed to do that",
  60: "the server's trial period is over",
  70: "the item wasn't found",
};

function http(ctx: KindContext<Config>) {
  return client(def, ctx, (status) => `The music server answered ${status}: it didn't accept Gluon's credentials.`);
}

/** Call a Subsonic method and unwrap `subsonic-response`, turning Subsonic errors into sentences. */
async function call(ctx: KindContext<Config>, method: string, query: Record<string, string | number> = {}, o: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const res = obj(await http(ctx).json(`/rest/${method}.view`, { query, ...o }));
  const sr = obj(res["subsonic-response"]);
  if (!sr.status) throw new UpstreamError("That address answered, but not like a Subsonic music server (Navidrome, Octo…). Check the address.");
  if (sr.status !== "ok") {
    const err = obj(sr.error);
    const code = num(err.code) ?? 0;
    const why = ERRORS[code] ?? str(err.message) ?? "unknown error";
    throw new UpstreamError(`${serverLabel(sr)} said ${why}.`, null, code === 40 || code === 44 ? "upstream_auth" : "upstream");
  }
  return sr;
}

function serverLabel(sr: Record<string, unknown>): string {
  const t = str(sr.type);
  if (!t) return "The music server";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cover(ctx: KindContext<Config>, id: unknown, w: number): string | null {
  const c = str(id);
  if (!c || !/^[A-Za-z0-9_.:-]{1,128}$/.test(c)) return null;
  return imageUrl(ctx.id, c, { cover: c, w: bucketWidth(w) });
}

async function nowPlaying(ctx: KindContext<Config>): Promise<SubsonicNowPlayingData> {
  const sr = await call(ctx, "getNowPlaying");
  return {
    entries: arr<Record<string, unknown>>(obj(sr.nowPlaying).entry).map((e) => ({
      id: String(e.id ?? ""),
      title: str(e.title) ?? "Unknown track",
      artist: str(e.artist) ?? str(e.displayArtist),
      album: str(e.album),
      image: cover(ctx, e.coverArt ?? e.albumId, 240),
      durationMs: num(e.duration) !== null ? num(e.duration)! * 1000 : null,
      user: str(e.username),
      player: str(e.playerName) ?? str(e.clientName),
      minutesAgo: num(e.minutesAgo),
    })),
  };
}

async function recent(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<SubsonicRecentData> {
  const size = Math.min(30, Math.max(1, Number(params.limit ?? 12)));
  const [list, scan] = await Promise.all([
    call(ctx, "getAlbumList2", { type: "newest", size }),
    call(ctx, "getScanStatus").catch(() => null),
  ]);
  const s = scan ? obj(scan.scanStatus) : null;
  return {
    albums: arr<Record<string, unknown>>(obj(list.albumList2).album).map((a) => ({
      id: String(a.id ?? ""),
      title: str(a.name) ?? str(a.title) ?? "Unknown album",
      artist: str(a.artist) ?? str(a.displayArtist),
      year: num(a.year),
      addedAt: time(a.created),
      songs: num(a.songCount),
      image: cover(ctx, a.coverArt ?? a.id, 240),
    })),
    scan:
      s && Object.keys(s).length
        ? { scanning: s.scanning === true, count: num(s.count), folderCount: num(s.folderCount), lastScan: time(s.lastScan) }
        : null,
  };
}

// ------------------------------------------------------------------ universal search

/** Navidrome's web app has a page per artist and album; other servers' pages aren't known, so no link. */
function webLink(ctx: KindContext<Config>, server: string | null, kind: "artist" | "album", id: string): string | undefined {
  if (!server || !/navidrome/i.test(server)) return undefined;
  return `${ctx.baseUrl.replace(/\/+$/, "")}/app/#/${kind}/${encodeURIComponent(id)}/show`;
}

/** search3's answer → hits: artists, albums and songs, the best-named first. */
export function searchHits(ctx: KindContext<Config>, sr: Record<string, unknown>, q: string, limit: number): KindSearchHit[] {
  const r = obj(sr.searchResult3);
  const server = str(sr.type);
  const out: { hit: KindSearchHit; rank: number }[] = [];
  for (const a of arr<Record<string, unknown>>(r.artist)) {
    const id = str(a.id);
    if (!id) continue;
    const n = num(a.albumCount);
    out.push({ rank: 0, hit: { id: `artist:${id}`, label: str(a.name) ?? "Unknown artist", hint: ["Artist", n !== null ? `${n} album${n === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "), url: webLink(ctx, server, "artist", id), type: "artist", image: cover(ctx, a.coverArt, 96) } });
  }
  for (const a of arr<Record<string, unknown>>(r.album)) {
    const id = str(a.id);
    if (!id) continue;
    const year = num(a.year);
    out.push({ rank: 1, hit: { id: `album:${id}`, label: str(a.name) ?? str(a.title) ?? "Unknown album", hint: ["Album", str(a.artist), year ? String(year) : null].filter(Boolean).join(" · "), url: webLink(ctx, server, "album", id), type: "album", image: cover(ctx, a.coverArt ?? a.id, 96) } });
  }
  for (const t of arr<Record<string, unknown>>(r.song)) {
    const id = str(t.id);
    if (!id) continue;
    const albumId = str(t.albumId);
    out.push({ rank: 2, hit: { id: `song:${id}`, label: str(t.title) ?? "Unknown track", hint: ["Song", [str(t.artist), str(t.album)].filter(Boolean).join(", ") || null].filter(Boolean).join(" · "), url: albumId ? webLink(ctx, server, "album", albumId) : undefined, type: "song", image: cover(ctx, t.coverArt ?? t.albumId, 96) } });
  }
  const query = prepare(q);
  return out
    .map((x, i) => ({ ...x, i, score: matchScore(query, { label: x.hit.label }) }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.hit);
}

async function search(ctx: KindContext<Config>, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const sr = await call(ctx, "search3", { query: q.slice(0, 100), artistCount: 3, albumCount: 4, songCount: 6 }, { signal: opts.signal, timeoutMs: 1800 });
  if (opts.signal.aborted) return [];
  return searchHits(ctx, sr, q, opts.limit);
}

export const def: KindDef<Config> = {
  kind: "subsonic",
  label: "Music server",
  noun: "the music server",
  description: "Navidrome, Octo or any Subsonic-compatible server: now playing and new albums.",
  baseUrlLabel: "Server address",
  baseUrlPlaceholder: "http://127.0.0.1:4533",
  keyHelp:
    "Use the username and password you sign in to the music server with (a separate account just for Gluon is best). Gluon never sends the password itself: each request carries a one-time salted token. Navidrome can also issue API keys (OpenSubsonic) in your profile.",
  fields: [
    {
      key: "auth",
      label: "Sign in with",
      type: "select",
      required: true,
      secret: false,
      options: [
        { value: "password", label: "Username and password" },
        { value: "token", label: "Username, token and salt" },
        { value: "apiKey", label: "API key (OpenSubsonic)" },
      ],
    },
    { key: "username", label: "Username", type: "text", required: false, secret: false, showWhen: { key: "auth", in: ["password", "token"] } },
    { key: "password", label: "Password", type: "password", required: false, secret: true, showWhen: { key: "auth", in: ["password"] } },
    { key: "token", label: "Token", type: "password", required: false, secret: true, help: "md5(password + salt), 32 hex characters.", showWhen: { key: "auth", in: ["token"] } },
    { key: "salt", label: "Salt", type: "text", required: false, secret: false, showWhen: { key: "auth", in: ["token"] } },
    { key: "apiKey", label: "API key", type: "password", required: false, secret: true, showWhen: { key: "auth", in: ["apiKey"] } },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["password", "token", "apiKey"],
  widgets: ["subsonic.nowPlaying", "subsonic.recent"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    const c = ctx.config;
    req.query.v = "1.16.1";
    req.query.c = "Gluon";
    req.query.f = "json";
    if (c.auth === "apiKey") {
      req.query.apiKey = c.apiKey;
    } else if (c.auth === "token") {
      req.query.u = c.username;
      req.query.t = c.token.toLowerCase();
      req.query.s = c.salt;
    } else {
      const salt = crypto.randomBytes(8).toString("hex");
      req.query.u = c.username;
      req.query.t = crypto.createHash("md5").update(c.password + salt).digest("hex");
      req.query.s = salt;
    }
  },
  test: (ctx) =>
    runTest(async () => {
      const sr = await call(ctx, "ping");
      const version = str(sr.serverVersion) ?? str(sr.version);
      const who = ctx.config.auth === "apiKey" ? null : ctx.config.username;
      let detail: string | null = null;
      try {
        await call(ctx, "getAlbumList2", { type: "newest", size: 1 });
      } catch (e) {
        detail = e instanceof UpstreamError ? `Signed in, but listing albums failed: ${e.message}` : null;
      }
      return ok(`Connected to ${serverLabel(sr)}${version ? ` ${version.split(" ")[0]}` : ""}${who ? ` as “${who}”` : ""}.`, {
        version: version ?? null,
        serverName: str(sr.type),
        detail,
      });
    }),
  data: {
    "subsonic.nowPlaying": (ctx) => nowPlaying(ctx),
    "subsonic.recent": (ctx, p) => recent(ctx, p),
  },
  search,
  image: {
    schema: z.object({
      cover: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
      w: z.coerce.number().int().min(32).max(2000).default(240),
    }) as unknown as z.ZodType<Record<string, string | number>>,
    ref: (p) => String(p.cover),
    request: (_ctx, p) => ({ path: "/rest/getCoverArt.view", query: { id: String(p.cover), size: String(bucketWidth(Number(p.w))) } }),
  },
};
