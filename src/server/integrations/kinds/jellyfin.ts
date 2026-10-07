import "server-only";
import { z } from "zod";
import { arr, client, num, obj, ok, runTest, str, time, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { matchScore, prepare } from "@/lib/search-match";
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

/**
 * The person whose view "recently added" and library counts follow. None chosen means the API key's own view,
 * which sees every library: picking "the first admin" by default hid everything whenever that account had
 * no library access (or Jellyfin's library folders had drifted from its items).
 */
function userId(ctx: KindContext<Config>): string | null {
  return ctx.config.userId ?? null;
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
    else if (kind === "track") subtitle = [str(it.AlbumArtist) ?? str(arr(it.Artists)[0]), str(it.Album)].filter(Boolean).join(" · ") || null;
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
  const uid = userId(ctx);
  // One query per kind: in one shared window a busy show's episodes crowd out every movie and album.
  // Episodes get a wider window since they collapse into one entry per show.
  const lists = await Promise.all(
    include
      .filter((k) => TYPE_FOR[k])
      .map(async (k) =>
        arr<Item>(
          obj(
            await http(ctx).json("/Items", {
              query: {
                userId: uid ?? undefined,
                SortBy: "DateCreated,SortName",
                SortOrder: "Descending",
                Recursive: true,
                IncludeItemTypes: TYPE_FOR[k],
                Limit: k === "episode" ? Math.min(300, limit * 12) : limit,
                Fields: "DateCreated,ProductionYear",
                EnableImageTypes: "Primary",
                ImageTypeLimit: 1,
                EnableTotalRecordCount: false,
                IsMissing: false,
                EnableUserData: false,
              },
            }),
          ).Items,
        ),
      ),
  );
  const data = { Items: lists.flat().sort((a, b) => (time(b.DateCreated) ?? 0) - (time(a.DateCreated) ?? 0)) };
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

/** Global counter for each library kind, used when a library's own count can't be trusted. */
const KIND_COUNT: Record<string, string> = {
  movies: "MovieCount",
  tvshows: "SeriesCount",
  music: "AlbumCount",
  musicvideos: "MusicVideoCount",
  books: "BookCount",
  boxsets: "BoxSetCount",
};

async function libraries(ctx: KindContext<Config>): Promise<JellyfinLibrariesData> {
  const h = http(ctx);
  const uid = userId(ctx);
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
  const kinds = libs.map((l) => String(l.CollectionType ?? ""));
  // Jellyfin says it has movies and shows, yet none of its libraries contain them: its library folders no longer
  // match where the items were filed (after moving media or re-adding a library). A scan fixes it; until then
  // Jellyfin's own apps show empty libraries too, so say so instead of showing zeros.
  const total = n("MovieCount") + n("SeriesCount") + n("AlbumCount") + n("MusicVideoCount") + n("BookCount");
  const drifted = total > 0 && libs.length > 0 && perLib.every((x) => !x);
  const countFor = (i: number): number | null => {
    const own = perLib[i] ?? null;
    if (!drifted) return own;
    const key = KIND_COUNT[kinds[i]!];
    // The server-wide count stands in only when this library is the one library of its kind.
    return key && kinds.filter((k) => k === kinds[i]).length === 1 ? n(key) : own;
  };
  return {
    libraries: libs.map((l, i) => {
      const ct = kinds[i]!;
      return {
        id: String(l.ItemId ?? l.Name),
        name: str(l.Name) ?? "Library",
        kind: (LIB_KINDS.has(ct) ? ct : "other") as JellyfinLibrariesData["libraries"][number]["kind"],
        count: countFor(i),
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
    note: drifted ? DRIFT_NOTE : null,
  };
}

const DRIFT_NOTE =
  "Jellyfin's libraries look empty to its apps: its items aren't filed under the library folders any more. In Jellyfin, open Dashboard → Libraries and choose Scan All Libraries.";

/** What the chosen person (or the key) can see, compared with everything Jellyfin holds. */
async function visibility(ctx: KindContext<Config>): Promise<string | null> {
  const h = http(ctx);
  const everything = obj(await h.json("/Items/Counts"));
  const all = ["MovieCount", "SeriesCount", "AlbumCount", "MusicVideoCount", "BookCount"].reduce((a, k) => a + (num(everything[k]) ?? 0), 0);
  if (!all) return null;
  const folders = arr<Item>(await h.json("/Library/VirtualFolders"));
  const counts = await Promise.all(
    folders.slice(0, 16).map(async (l) => {
      const type = MAIN_TYPES[String(l.CollectionType ?? "mixed")];
      if (!type || !str(l.ItemId)) return 0;
      const r = obj(await h.json("/Items", { query: { ParentId: String(l.ItemId), Recursive: true, Limit: 0, IncludeItemTypes: type, EnableTotalRecordCount: true, EnableImages: false } }));
      return num(r.TotalRecordCount) ?? 0;
    }),
  );
  if (folders.length && counts.every((x) => !x)) return DRIFT_NOTE;
  if (ctx.config.userId) {
    const mine = obj(await h.json("/Items", { query: { userId: ctx.config.userId, Recursive: true, Limit: 0, IncludeItemTypes: "Movie,Series,MusicAlbum", EnableTotalRecordCount: true, EnableImages: false } }));
    if (!num(mine.TotalRecordCount)) {
      return "The person chosen for “recently added” can't see any of Jellyfin's libraries. Give them access in Jellyfin (Dashboard → Users → Access), or leave the choice empty to show everything.";
    }
  }
  return null;
}

// ------------------------------------------------------------------ universal search

/** What a search hit is, for the palette's icon and the hint's first word. */
const SEARCH_TYPES: Record<string, { type: string; word: string; rank: number }> = {
  Movie: { type: "film", word: "Film", rank: 0 },
  Series: { type: "series", word: "Series", rank: 0 },
  MusicArtist: { type: "artist", word: "Artist", rank: 1 },
  MusicAlbum: { type: "album", word: "Album", rank: 1 },
  BoxSet: { type: "collection", word: "Collection", rank: 1 },
  Episode: { type: "episode", word: "Episode", rank: 2 },
  Audio: { type: "song", word: "Song", rank: 2 },
  MusicVideo: { type: "video", word: "Music video", rank: 2 },
};

/** One Jellyfin item → a search hit linking to its page in Jellyfin's web app. */
export function searchHit(ctx: KindContext<Config>, it: Item): KindSearchHit | null {
  const id = str(it.Id);
  const t = SEARCH_TYPES[String(it.Type)];
  if (!id || !t) return null;
  const year = num(it.ProductionYear);
  let detail: string | null = null;
  if (it.Type === "Episode") detail = [str(it.SeriesName), episodeLabel(it)].filter(Boolean).join(" ") || null;
  else if (it.Type === "Audio") detail = [str(it.AlbumArtist) ?? str(arr(it.Artists)[0]), str(it.Album)].filter(Boolean).join(", ") || null;
  else if (it.Type === "MusicAlbum") detail = str(it.AlbumArtist) ?? str(arr(it.Artists)[0]);
  const hint = [t.word, detail, it.Type !== "Episode" && it.Type !== "Audio" && year ? String(year) : null].filter(Boolean).join(" · ");
  const server = str(it.ServerId);
  const url = `${ctx.baseUrl.replace(/\/+$/, "")}/web/#/details?id=${encodeURIComponent(id)}${server ? `&serverId=${encodeURIComponent(server)}` : ""}`;
  return { id, label: str(it.Name) ?? "Untitled", hint, url, type: t.type, image: posterOf(ctx, it, 96) };
}

/** Films, series, episodes and music by name, as the chosen person sees them (else the whole server). */
async function search(ctx: KindContext<Config>, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const res = obj(
    await http(ctx).json("/Items", {
      signal: opts.signal,
      timeoutMs: 1800, // backstop; search aborts sooner through the signal
      query: {
        userId: userId(ctx) ?? undefined,
        searchTerm: q.slice(0, 100),
        Recursive: true,
        IncludeItemTypes: Object.keys(SEARCH_TYPES).join(","),
        Limit: Math.min(40, opts.limit * 4),
        Fields: "ProductionYear,ParentId",
        EnableImageTypes: "Primary",
        ImageTypeLimit: 1,
        EnableTotalRecordCount: false,
        EnableUserData: false,
        IsMissing: false,
      },
    }),
  );
  if (opts.signal.aborted) return [];
  const query = prepare(q);
  return arr<Item>(res.Items)
    .map((it, i) => ({ it, i, score: matchScore(query, { label: str(it.Name) ?? "" }), rank: SEARCH_TYPES[String(it.Type)]?.rank ?? 3 }))
    // The name that matches best first; among equals, films and shows before episodes and songs.
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.i - b.i)
    .map(({ it }) => searchHit(ctx, it))
    .filter((h): h is KindSearchHit => !!h)
    .slice(0, opts.limit);
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
      help: "Pick a person to respect their library access and parental limits. Test the connection to load the list. Empty shows everything.",
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
      } else {
        detail = await visibility(ctx).catch(() => null);
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
  search,
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
