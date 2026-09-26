import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef } from "./base";
import { bucketWidth, imageUrl } from "../image-refs";
import type { JellyfinLibrariesData, JellyfinNowPlayingData, JellyfinRecentData, MediaKind, NowPlayingSession, RecentMediaItem } from "@/lib/widgets-types";

const schema = z.object({
  apiKey: z.string().trim().min(16, "Paste the whole API key from Jellyfin.").max(200),
  /** Show recently added items as this user sees them (their libraries and parental limits). */
  userId: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().replace(/-/g, "").toLowerCase() || null : (v ?? null)),
    z.string().regex(/^[a-f0-9]{32}$/, "That isn't a Jellyfin user id.").nullable(),
  ),
  allowSelfSigned: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;

type Item = Record<string, unknown>;

const TICKS_PER_MS = 10_000;

function kindOf(type: unknown): MediaKind {
  switch (type) {
    case "Movie":
      return "movie";
    case "Series":
      return "series";
    case "Episode":
      return "episode";
    case "MusicAlbum":
      return "album";
    case "Audio":
      return "track";
    case "MusicVideo":
    case "Video":
    case "Trailer":
      return "video";
    default:
      return "other";
  }
}

function episodeLabel(it: Item): string | null {
  const s = num(it.ParentIndexNumber);
  const e = num(it.IndexNumber);
  if (s === null && e === null) return null;
  return [s !== null ? `S${s}` : null, e !== null ? `E${e}` : null].filter(Boolean).join(" ");
}

function img(ctx: KindContext<Config>, itemId: unknown, tag: unknown, width: number, type: "Primary" | "Backdrop" | "Thumb" = "Primary"): string | null {
  const id = str(itemId);
  if (!id || !/^[a-f0-9]{32}$/i.test(id)) return null;
  const params: Record<string, string | number> = { item: id.toLowerCase(), type, w: bucketWidth(width) };
  const t = str(tag);
  if (t && /^[A-Za-z0-9]{1,64}$/.test(t)) params.tag = t;
  return imageUrl(ctx.id, `${id.toLowerCase()}:${type}`, params);
}

/** Best poster for an item: its own, else the series', else the album's, else the parent's. */
function posterOf(ctx: KindContext<Config>, it: Item, width: number): string | null {
  const tags = obj(it.ImageTags);
  if (it.Type === "Episode" && it.SeriesId && it.SeriesPrimaryImageTag) return img(ctx, it.SeriesId, it.SeriesPrimaryImageTag, width);
  if (it.Type === "Audio" && it.AlbumId && it.AlbumPrimaryImageTag) return img(ctx, it.AlbumId, it.AlbumPrimaryImageTag, width);
  if (tags.Primary) return img(ctx, it.Id, tags.Primary, width);
  if (it.ParentPrimaryImageItemId && it.ParentPrimaryImageTag) return img(ctx, it.ParentPrimaryImageItemId, it.ParentPrimaryImageTag, width);
  return null;
}

function humanReason(r: string): string {
  const s = r.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function http(ctx: KindContext<Config>) {
  return client(def, ctx, (status) =>
    status === 401 ? "Jellyfin answered 401: the API key is wrong (or was deleted)." : "Jellyfin answered 403: this API key isn't allowed to do that.",
  );
}

// Default user for per-user endpoints when none is configured: the first administrator.
const defaultUsers = new Map<string, { at: number; id: string | null }>();
async function userId(ctx: KindContext<Config>): Promise<string | null> {
  if (ctx.config.userId) return ctx.config.userId;
  const key = `${ctx.id ?? ctx.baseUrl}:${ctx.version}`;
  const hit = defaultUsers.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  const users = arr<Item>(await http(ctx).json("/Users"));
  const admin = users.find((u) => obj(u.Policy).IsAdministrator === true && obj(u.Policy).IsDisabled !== true) ?? users[0];
  const id = str(admin?.Id);
  defaultUsers.set(key, { at: Date.now(), id });
  return id;
}

async function sessions(ctx: KindContext<Config>): Promise<Item[]> {
  return arr<Item>(await http(ctx).json("/Sessions", { query: { activeWithinSeconds: 960 } })).filter((s) => s.NowPlayingItem);
}

async function nowPlaying(ctx: KindContext<Config>): Promise<JellyfinNowPlayingData> {
  const list = await sessions(ctx);
  const out: NowPlayingSession[] = list.map((s) => {
    const it = obj(s.NowPlayingItem);
    const play = obj(s.PlayState);
    const tr = obj(s.TranscodingInfo);
    const kind = kindOf(it.Type);
    let subtitle: string | null = null;
    if (kind === "episode") subtitle = [str(it.SeriesName), episodeLabel(it)].filter(Boolean).join(" · ") || null;
    else if (kind === "track") subtitle = [str(it.AlbumArtist) ?? str(arr(it.Artists)[0]), str(it.Album)].filter(Boolean).join(" — ") || null;
    const pos = num(play.PositionTicks);
    const dur = num(it.RunTimeTicks);
    const method = play.PlayMethod === "Transcode" ? "transcode" : play.PlayMethod === "DirectStream" ? "directStream" : play.PlayMethod === "DirectPlay" ? "direct" : null;
    const reasons = arr<string>(tr.TranscodeReasons).filter((r) => typeof r === "string");
    return {
      id: String(s.Id ?? it.Id ?? Math.random()),
      user: str(s.UserName),
      client: str(s.Client),
      device: str(s.DeviceName),
      item: {
        id: String(it.Id ?? ""),
        kind,
        title: str(it.Name) ?? "Untitled",
        subtitle,
        year: num(it.ProductionYear),
        image: posterOf(ctx, it, 240),
      },
      positionMs: pos !== null ? Math.round(pos / TICKS_PER_MS) : null,
      durationMs: dur !== null ? Math.round(dur / TICKS_PER_MS) : null,
      progress: pos !== null && dur ? Math.min(1, Math.max(0, pos / dur)) : null,
      paused: play.IsPaused === true,
      playMethod: method,
      transcodeReason: method === "transcode" && reasons.length ? reasons.map(humanReason).join(", ") : null,
    };
  });
  // Playing first, then paused; stable by user.
  out.sort((a, b) => Number(a.paused) - Number(b.paused) || (a.user ?? "").localeCompare(b.user ?? ""));
  return { sessions: out, activeStreams: out.length, transcoding: out.filter((s) => s.playMethod === "transcode").length };
}

const TYPE_FOR: Record<string, string> = { movie: "Movie", episode: "Episode", album: "MusicAlbum" };

async function recent(ctx: KindContext<Config>, params: Record<string, unknown>): Promise<JellyfinRecentData> {
  const limit = Math.min(30, Math.max(1, Number(params.limit ?? 12)));
  const include = (Array.isArray(params.include) ? params.include : ["movie", "episode"]) as string[];
  const uid = await userId(ctx);
  const data = obj(
    await http(ctx).json("/Items", {
      query: {
        userId: uid ?? undefined,
        SortBy: "DateCreated,SortName",
        SortOrder: "Descending",
        Recursive: true,
        IncludeItemTypes: include.map((k) => TYPE_FOR[k]).filter(Boolean).join(","),
        Limit: Math.min(100, limit * 5),
        Fields: "DateCreated,ProductionYear",
        EnableImageTypes: "Primary",
        ImageTypeLimit: 1,
        EnableTotalRecordCount: false,
        IsMissing: false,
        EnableUserData: false,
      },
    }),
  );
  const items: RecentMediaItem[] = [];
  const bySeries = new Map<string, RecentMediaItem>();
  for (const it of arr<Item>(data.Items)) {
    if (items.length >= limit && !(it.Type === "Episode" && bySeries.has(String(it.SeriesId)))) continue;
    const kind = kindOf(it.Type);
    if (kind === "episode" && str(it.SeriesId)) {
      const sid = String(it.SeriesId);
      const existing = bySeries.get(sid);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.kind = "series";
        existing.title = str(it.SeriesName) ?? existing.title;
        existing.subtitle = `${existing.count} new episodes`;
        existing.id = sid;
        continue;
      }
      const entry: RecentMediaItem = {
        id: String(it.Id),
        kind: "episode",
        title: str(it.Name) ?? "Episode",
        subtitle: [str(it.SeriesName), episodeLabel(it)].filter(Boolean).join(" · ") || null,
        year: num(it.ProductionYear),
        addedAt: time(it.DateCreated),
        image: posterOf(ctx, it, 240),
        count: 1,
      };
      bySeries.set(sid, entry);
      items.push(entry);
      continue;
    }
    items.push({
      id: String(it.Id),
      kind,
      title: str(it.Name) ?? "Untitled",
      subtitle: kind === "album" ? (str(it.AlbumArtist) ?? str(arr(it.Artists)[0])) : null,
      year: num(it.ProductionYear),
      addedAt: time(it.DateCreated),
      image: posterOf(ctx, it, 240),
      count: null,
    });
  }
  return { items: items.slice(0, limit) };
}

const MAIN_TYPES: Record<string, string> = {
  movies: "Movie",
  tvshows: "Series",
  music: "MusicAlbum",
  musicvideos: "MusicVideo",
  homevideos: "Video,Photo",
  books: "Book",
  boxsets: "BoxSet",
  mixed: "Movie,Series",
};
const LIB_KINDS = new Set(["movies", "tvshows", "music", "musicvideos", "homevideos", "boxsets", "books", "mixed"]);

async function libraries(ctx: KindContext<Config>): Promise<JellyfinLibrariesData> {
  const h = http(ctx);
  const uid = await userId(ctx).catch(() => null);
  const [folders, counts, sess] = await Promise.all([
    h.json<unknown>("/Library/VirtualFolders"),
    h.json<unknown>("/Items/Counts", { query: { userId: uid ?? undefined } }),
    sessions(ctx).catch(() => [] as Item[]),
  ]);
  const libs = arr<Item>(folders).slice(0, 16);
  const perLib = await Promise.all(
    libs.map(async (l) => {
      const type = MAIN_TYPES[String(l.CollectionType ?? "mixed")];
      if (!type || !str(l.ItemId)) return null;
      try {
        const r = obj(
          await h.json("/Items", {
            query: { userId: uid ?? undefined, ParentId: String(l.ItemId), Recursive: true, Limit: 0, IncludeItemTypes: type, EnableTotalRecordCount: true, EnableImages: false },
          }),
        );
        return num(r.TotalRecordCount);
      } catch {
        return null;
      }
    }),
  );
  const c = obj(counts);
  const n = (k: string) => num(c[k]) ?? 0;
  return {
    libraries: libs.map((l, i) => {
      const ct = String(l.CollectionType ?? "");
      return {
        id: String(l.ItemId ?? l.Name),
        name: str(l.Name) ?? "Library",
        kind: (LIB_KINDS.has(ct) ? ct : "other") as JellyfinLibrariesData["libraries"][number]["kind"],
        count: perLib[i] ?? null,
        image: img(ctx, l.PrimaryImageItemId ?? l.ItemId, null, 320),
      };
    }),
    counts: {
      movies: n("MovieCount"),
      series: n("SeriesCount"),
      episodes: n("EpisodeCount"),
      albums: n("AlbumCount"),
      songs: n("SongCount"),
      artists: n("ArtistCount"),
      musicVideos: n("MusicVideoCount"),
      books: n("BookCount"),
    },
    activeStreams: sess.length,
  };
}

export const def: KindDef<Config> = {
  kind: "jellyfin",
  label: "Jellyfin",
  description: "Movies, shows and music: now watching, recently added and library sizes.",
  baseUrlLabel: "Jellyfin address",
  baseUrlPlaceholder: "http://127.0.0.1:8096",
  keyHelp:
    "In Jellyfin, open Dashboard → API Keys (under Advanced), press +, name it “Gluon”, and copy the key. Keys made there have admin access, so Gluon only ever reads with it.",
  fields: [
    { key: "apiKey", label: "API key", type: "password", required: true, secret: true, placeholder: "32 characters" },
    {
      key: "userId",
      label: "Show recently added as",
      type: "select",
      required: false,
      secret: false,
      help: "Pick a person to respect their library access and parental limits. Test the connection to load the list. Empty = the first admin.",
    },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["apiKey"],
  widgets: ["jellyfin.nowPlaying", "jellyfin.recent", "jellyfin.libraries"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    const device = (ctx.id ?? "test").replace(/[^A-Za-z0-9_-]/g, "");
    req.headers.Authorization = `MediaBrowser Client="Gluon", Device="Gluon", DeviceId="gluon-${device}", Version="1.0", Token="${ctx.config.apiKey.replace(/"/g, "")}"`;
  },
  test: (ctx) =>
    runTest(async () => {
      const h = http(ctx);
      // Unauthenticated first, so a wrong address isn't reported as a wrong key.
      const pub = obj(await h.json("/System/Info/Public", { noAuth: true, allow: [401, 403, 404] }).catch((e) => {
        if (e instanceof UpstreamError && e.code === "upstream") return { __status: 0 };
        throw e;
      }));
      if (num(pub.__status) !== null || (str(pub.ProductName) && !/jellyfin|emby/i.test(String(pub.ProductName))) || (!pub.Id && !pub.Version)) {
        throw new UpstreamError("That address answered, but it isn't Jellyfin. Check the port (Jellyfin's web page listens on it).");
      }
      const info = obj(await h.json("/System/Info"));
      const version = str(info.Version);
      const name = str(info.ServerName);
      if (str(info.ProductName) && !/jellyfin/i.test(String(info.ProductName))) {
        return { ...ok(`Connected, but this looks like ${info.ProductName}, not Jellyfin.`), ok: false };
      }
      const users = arr<Item>(await h.json("/Users").catch(() => []))
        .filter((u) => str(u.Id))
        .map((u) => ({ id: String(u.Id).toLowerCase(), name: str(u.Name) ?? "User" }));
      let detail: string | null = null;
      if (ctx.config.userId && !users.some((u) => u.id === ctx.config.userId)) {
        detail = "The person chosen for “recently added” no longer exists in Jellyfin; pick another.";
      }
      return ok(`Connected to Jellyfin${version ? ` ${version}` : ""}${name ? ` as “${name}”` : ""}.`, {
        version,
        serverName: name,
        options: { users },
        detail,
      });
    }),
  data: {
    "jellyfin.nowPlaying": (ctx) => nowPlaying(ctx),
    "jellyfin.recent": (ctx, p) => recent(ctx, p),
    "jellyfin.libraries": (ctx) => libraries(ctx),
  },
  image: {
    schema: z.object({
      item: z.string().regex(/^[a-f0-9]{32}$/i),
      type: z.enum(["Primary", "Backdrop", "Thumb"]).default("Primary"),
      tag: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(),
      w: z.coerce.number().int().min(32).max(2000).default(320),
    }) as unknown as z.ZodType<Record<string, string | number>>,
    ref: (p) => `${String(p.item).toLowerCase()}:${p.type}`,
    request: (_ctx, p) => ({
      path: `/Items/${String(p.item).toLowerCase()}/Images/${p.type}`,
      query: { maxWidth: String(bucketWidth(Number(p.w))), quality: "85", ...(p.tag ? { tag: String(p.tag) } : {}) },
    }),
  },
};
