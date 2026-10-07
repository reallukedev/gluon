"use client";
import * as React from "react";
import { Pause, Play } from "iconoir-react";
import type { SettingsProps, WidgetProps } from "../../types";
import { useSmartUrl } from "../core";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { UsageBar } from "@/components/ui/Surface";
import type { IntegrationKind, IntegrationRef, NowPlayingSession, RecentMediaItem } from "@/lib/widgets-types";
import { Gate, IntegrationPicker, perSize, Poster, Quiet, RowsSkeleton, ShelfSkeleton, StatsSkeleton, useIntegrationWidget } from "./shared";
import l from "./live.module.css";

// ---------------------------------------------------------------- common bits

export interface IntegrationConfig {
  integration?: string;
  title?: string;
}

export function TitleField<C extends { title?: string }>({ config, onChange, placeholder }: SettingsProps<C> & { placeholder: string }) {
  return (
    <Field label="Title" optional>
      <Input value={config.title ?? ""} maxLength={40} onChange={(e) => onChange({ ...config, title: e.target.value || undefined })} placeholder={placeholder} />
    </Field>
  );
}

/** 83 min → "1:23:00"; 4 min → "4:00". */
function clock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function Progress({ value, paused, label }: { value: number; paused?: boolean; label: string }) {
  return (
    <span className={l.progress} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span className={l.progressFill} data-paused={paused ? "" : undefined} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

/** Wrap content in a link to the app when Gluon knows its address. */
function AppLink({ src, children, className, title }: { src: IntegrationRef | null; children: React.ReactNode; className?: string; title?: string }) {
  const url = useSmartUrl();
  const { prefs } = usePrefs();
  const href = src ? url(src.links) : null;
  if (!href) {
    return (
      <div className={className} title={title}>
        {children}
      </div>
    );
  }
  return (
    <a className={className} href={href} title={title} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer">
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- Jellyfin: now watching

export function JellyfinNowPlaying({ item, size }: WidgetProps<IntegrationConfig>) {
  const q = useIntegrationWidget("jellyfin", "jellyfin.nowPlaying", item.config.integration, {});
  const one = size === "s";
  return (
    <Gate kind="jellyfin" source={q.source} q={q} skeleton={<RowsSkeleton rows={one ? 1 : 2} thumb={36} ratio={2 / 3} />}>
      {(d) =>
        d.sessions.length === 0 ? (
          <Quiet title="Nothing playing">When someone starts watching, it shows up here.</Quiet>
        ) : (
          <ul className={l.list} role="list">
            {(one ? d.sessions.slice(0, 1) : d.sessions).map((s) => (
              <SessionRow key={s.id} s={s} compact={one} />
            ))}
            {one && d.sessions.length > 1 && <li className={l.more}>and {d.sessions.length - 1} more</li>}
          </ul>
        )
      }
    </Gate>
  );
}

function SessionRow({ s, compact }: { s: NowPlayingSession; compact?: boolean }) {
  const { viewer } = usePrefs();
  const who = [s.user, s.device ?? s.client].filter(Boolean).join(" · ");
  return (
    <li className={l.row}>
      <Poster src={s.item.image} title={s.item.title} square={s.item.kind === "track"} className={l.thumb} />
      <div className={l.rowText}>
        <span className={l.rowTitle} title={s.item.title}>
          {s.item.title}
        </span>
        {s.item.subtitle && (
          <span className={l.rowSub} title={s.item.subtitle}>
            {s.item.subtitle}
          </span>
        )}
        {!compact && who && (
          <span className={l.rowMeta}>
            {s.paused && <Pause className={l.inlineIcon} aria-label="Paused" />}
            {who}
            {viewer.role === "admin" && s.playMethod === "transcode" && (
              <span title={s.transcodeReason ?? undefined}> · Converting on the server</span>
            )}
          </span>
        )}
        {s.progress !== null && (
          <span className={l.progressRow}>
            <Progress value={s.progress} paused={s.paused} label={`${s.item.title}: ${Math.round(s.progress * 100)}% watched`} />
            {!compact && (
              <span className={`${l.progressTime} num`}>
                {clock(s.positionMs)} / {clock(s.durationMs)}
              </span>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- Jellyfin: recently added

export interface RecentConfig extends IntegrationConfig {
  include?: ("movie" | "episode" | "album")[];
}

function Shelf({ items, rows, src, square }: { items: { id: string; title: string; subtitle: string | null; image: string | null; square?: boolean }[]; rows: number; src: IntegrationRef | null; square?: boolean }) {
  return (
    <div className={l.shelfWrap}>
      <ul className={l.shelf} role="list" style={{ "--r": rows } as React.CSSProperties}>
        {items.map((it) => {
          const sq = square || it.square;
          return (
            <li key={it.id} className={l.card} data-square={sq ? "" : undefined}>
              <AppLink src={src} className={l.cardLink} title={it.subtitle ? `${it.title} · ${it.subtitle}` : it.title}>
                <Poster src={it.image} title={it.title} square={sq} />
                <span className={l.cardTitle}>{it.title}</span>
                {it.subtitle && <span className={l.cardSub}>{it.subtitle}</span>}
              </AppLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function JellyfinRecent({ item, size }: WidgetProps<RecentConfig>) {
  const include = item.config.include?.length ? item.config.include : ["movie", "episode"];
  const limit = perSize(size, { m: 8, w: 16, l: 14, x: 28 }, 10);
  const rows = size === "l" || size === "x" ? 2 : 1;
  const q = useIntegrationWidget("jellyfin", "jellyfin.recent", item.config.integration, { limit, include });
  const src = q.source.state === "ok" ? q.source.ref : null;
  return (
    <Gate kind="jellyfin" source={q.source} q={q} skeleton={<ShelfSkeleton rows={rows} />}>
      {(d) =>
        d.items.length === 0 ? (
          <Quiet title="Nothing new yet">Movies and shows added to Jellyfin appear here.</Quiet>
        ) : (
          <Shelf
            rows={rows}
            src={src}
            items={d.items.map((it: RecentMediaItem) => ({
              id: it.id,
              title: it.title,
              subtitle: it.subtitle ?? (it.year ? String(it.year) : null),
              image: it.image,
              square: it.kind === "album",
            }))}
          />
        )
      }
    </Gate>
  );
}

export function JellyfinRecentSettings({ config, onChange }: SettingsProps<RecentConfig>) {
  const include = config.include?.length ? config.include : ["movie", "episode"];
  const toggle = (k: "movie" | "episode" | "album", on: boolean) => {
    const next = on ? [...new Set([...include, k])] : include.filter((x) => x !== k);
    if (next.length) onChange({ ...config, include: next as RecentConfig["include"] });
  };
  return (
    <div className={l.form}>
      <IntegrationPicker kind="jellyfin" value={config.integration} onChange={(integration) => onChange({ ...config, integration })} />
      <Field label="Show">
        <div className={l.checks}>
          <Checkbox checked={include.includes("movie")} onChange={(v) => toggle("movie", v)}>
            Movies
          </Checkbox>
          <Checkbox checked={include.includes("episode")} onChange={(v) => toggle("episode", v)}>
            Episodes
          </Checkbox>
          <Checkbox checked={include.includes("album")} onChange={(v) => toggle("album", v)}>
            Music albums
          </Checkbox>
        </div>
      </Field>
      <TitleField config={config} onChange={onChange} placeholder="New on Jellyfin" />
    </div>
  );
}

export function IntegrationSettingsFor(kind: IntegrationKind, placeholder: string) {
  return function Settings({ config, onChange }: SettingsProps<IntegrationConfig>) {
    return (
      <div className={l.form}>
        <IntegrationPicker kind={kind} value={config.integration} onChange={(integration) => onChange({ ...config, integration })} />
        <TitleField config={config} onChange={onChange} placeholder={placeholder} />
      </div>
    );
  };
}

// ---------------------------------------------------------------- Jellyfin: libraries

const COUNT_LABELS: [keyof import("@/lib/widgets-types").JellyfinLibrariesData["counts"], string][] = [
  ["movies", "Movies"],
  ["series", "Shows"],
  ["episodes", "Episodes"],
  ["albums", "Albums"],
  ["songs", "Songs"],
  ["artists", "Artists"],
  ["musicVideos", "Music videos"],
  ["books", "Books"],
];

export function JellyfinLibraries({ item, size }: WidgetProps<IntegrationConfig>) {
  const fmt = useFormat();
  const { viewer } = usePrefs();
  const q = useIntegrationWidget("jellyfin", "jellyfin.libraries", item.config.integration, {});
  const max = perSize(size, { s: 2, m: 4, t: 4 }, 4);
  return (
    <Gate kind="jellyfin" source={q.source} q={q} skeleton={<StatsSkeleton n={max} />}>
      {(d) => {
        const counts = COUNT_LABELS.filter(([k]) => d.counts[k] > 0).slice(0, max);
        if (!counts.length && !d.libraries.length) return <Quiet title="No libraries yet">Add a library in Jellyfin and it's counted here.</Quiet>;
        return (
          <div className={l.col}>
            <div className={l.stats} data-cols={size === "m" ? 4 : 2}>
              {counts.map(([k, label]) => (
                <div key={k} className={l.stat}>
                  <span className="label">{label}</span>
                  <span className={`${l.statValue} num`}>{d.counts[k].toLocaleString()}</span>
                </div>
              ))}
            </div>
            {size === "t" && d.libraries.length > 0 && (
              <ul className={l.kv} role="list">
                {d.libraries.map((lib) => (
                  <li key={lib.id}>
                    <span className="truncate" title={lib.name}>
                      {lib.name}
                    </span>
                    {lib.count !== null ? <span className="num">{lib.count.toLocaleString()}</span> : <span className="muted">Not counted</span>}
                  </li>
                ))}
              </ul>
            )}
            {d.activeStreams > 0 && size !== "s" && <p className={l.foot}>{fmt.plural(d.activeStreams, "person", "people")} watching now</p>}
            {d.note && viewer.role === "admin" && size !== "s" && (
              <p className={l.foot} title={d.note}>
                Jellyfin needs a library scan: its apps see these libraries as empty.
              </p>
            )}
          </div>
        );
      }}
    </Gate>
  );
}

// ---------------------------------------------------------------- Immich

export interface ImmichConfig extends IntegrationConfig {
  memories?: boolean;
}

export function ImmichStats({ item, size }: WidgetProps<ImmichConfig>) {
  const fmt = useFormat();
  const { viewer } = usePrefs();
  const big = size === "l" || size === "w";
  const wantMemories = big && item.config.memories !== false;
  const q = useIntegrationWidget("immich", "immich.stats", item.config.integration, { memories: wantMemories });
  const src = q.source.state === "ok" ? q.source.ref : null;
  return (
    <Gate kind="immich" source={q.source} q={q} skeleton={<StatsSkeleton n={3} />}>
      {(d) => {
        const total = d.users.reduce((a, u) => a + u.usageBytes, 0);
        const users = [...d.users].sort((a, b) => b.usageBytes - a.usageBytes);
        const memories = (d.memories ?? []).filter((m) => m.assets.length);
        return (
          <div className={l.col} data-split={big && memories.length ? "" : undefined}>
            <div className={l.col}>
              <div className={l.stats} data-cols={size === "s" ? 2 : 3}>
                <div className={l.stat}>
                  <span className="label">Photos</span>
                  <span className={`${l.statValue} num`}>{d.photos.toLocaleString()}</span>
                </div>
                <div className={l.stat}>
                  <span className="label">Videos</span>
                  <span className={`${l.statValue} num`}>{d.videos.toLocaleString()}</span>
                </div>
                {size !== "s" && d.usageBytes !== null && (
                  <div className={l.stat}>
                    <span className="label">Space</span>
                    <span className={`${l.statValue} num`}>{fmt.bytes(d.usageBytes)}</span>
                  </div>
                )}
              </div>
              {d.scope === "user" && size !== "s" && viewer.role === "admin" && (
                <p className={l.foot}>Only the key owner's library. Use an admin's key for everyone's.</p>
              )}
              {(size === "t" || size === "l" || size === "w") && users.length > 1 && (
                <ul className={l.bars} role="list">
                  {users.slice(0, size === "t" ? 5 : 4).map((u) => (
                    <li key={u.id}>
                      <span className={l.barHead}>
                        <span className="truncate">{u.name}</span>
                        <span className="num">
                          {fmt.bytes(u.usageBytes)}
                          {u.quotaBytes ? ` of ${fmt.bytes(u.quotaBytes)}` : ""}
                        </span>
                      </span>
                      <UsageBar value={u.usageBytes} max={u.quotaBytes ?? (total || 1)} attention={u.quotaBytes ? 90 : undefined} label={`${u.name}: ${fmt.bytes(u.usageBytes)}`} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {wantMemories && memories.length > 0 && (
              <div className={l.memories}>
                {memories.slice(0, 2).map((m) => (
                  <div key={m.id} className={l.memory}>
                    <span className="label">{m.title}</span>
                    <AppLink src={src} className={l.thumbs}>
                      {m.assets.slice(0, 4).map((a) => (
                        <Poster key={a.id} src={a.image} title={m.title} square />
                      ))}
                    </AppLink>
                  </div>
                ))}
              </div>
            )}
            {wantMemories && !memories.length && d.memoriesNote && viewer.role === "admin" && <p className={l.foot}>{d.memoriesNote}</p>}
          </div>
        );
      }}
    </Gate>
  );
}

export function ImmichSettings({ config, onChange }: SettingsProps<ImmichConfig>) {
  return (
    <div className={l.form}>
      <IntegrationPicker kind="immich" value={config.integration} onChange={(integration) => onChange({ ...config, integration })} />
      <Checkbox checked={config.memories !== false} onChange={(v) => onChange({ ...config, memories: v })}>
        Show “on this day” memories in the large sizes
      </Checkbox>
      <TitleField config={config} onChange={onChange} placeholder="Photos" />
    </div>
  );
}

// ---------------------------------------------------------------- Subsonic / Navidrome / Octo

export function SubsonicNowPlaying({ item, size }: WidgetProps<IntegrationConfig>) {
  const q = useIntegrationWidget("subsonic", "subsonic.nowPlaying", item.config.integration, {});
  const one = size === "s";
  return (
    <Gate kind="subsonic" source={q.source} q={q} skeleton={<RowsSkeleton rows={one ? 1 : 2} thumb={40} />}>
      {(d) =>
        d.entries.length === 0 ? (
          <Quiet title="Nothing playing">When someone starts listening, it shows up here.</Quiet>
        ) : (
          <ul className={l.list} role="list">
            {(one ? d.entries.slice(0, 1) : d.entries).map((e) => (
              <li key={`${e.id}:${e.user}:${e.player}`} className={l.row}>
                <Poster src={e.image} title={e.album ?? e.title} square className={l.thumbSquare} />
                <div className={l.rowText}>
                  <span className={l.rowTitle} title={e.title}>
                    {e.title}
                  </span>
                  <span className={l.rowSub} title={[e.artist, e.album].filter(Boolean).join(" · ")}>
                    {[e.artist, e.album].filter(Boolean).join(" · ") || "Unknown artist"}
                  </span>
                  {!one && (e.user || e.player) && (
                    <span className={l.rowMeta}>
                      {[e.user, e.player].filter(Boolean).join(" on ")}
                      {e.minutesAgo !== null && e.minutesAgo > 0 ? ` · started ${e.minutesAgo} min ago` : ""}
                    </span>
                  )}
                </div>
              </li>
            ))}
            {one && d.entries.length > 1 && <li className={l.more}>and {d.entries.length - 1} more</li>}
          </ul>
        )
      }
    </Gate>
  );
}

export function SubsonicRecent({ item, size }: WidgetProps<IntegrationConfig>) {
  const limit = perSize(size, { m: 8, w: 16, l: 14 }, 10);
  const rows = size === "l" ? 2 : 1;
  const q = useIntegrationWidget("subsonic", "subsonic.recent", item.config.integration, { limit });
  const src = q.source.state === "ok" ? q.source.ref : null;
  return (
    <Gate kind="subsonic" source={q.source} q={q} skeleton={<ShelfSkeleton rows={rows} square />}>
      {(d) => (
        <>
          {d.albums.length === 0 ? (
            <Quiet title="No albums yet">New albums in your music library appear here.</Quiet>
          ) : (
            <Shelf rows={rows} src={src} square items={d.albums.map((a) => ({ id: a.id, title: a.title, subtitle: a.artist, image: a.image }))} />
          )}
          {d.scan?.scanning && (
            <p className={`${l.foot} ${l.footPad}`} role="status">
              Scanning the library{d.scan.count ? ` · ${d.scan.count.toLocaleString()} songs so far` : "…"}
            </p>
          )}
        </>
      )}
    </Gate>
  );
}


// ---------------------------------------------------------------- Immich: latest photos

export interface ImmichRecentConfig extends IntegrationConfig {
  show?: "all" | "photos" | "videos";
}

/** The newest photos as an even wall of squares that fills the widget; videos carry a play mark. */
export function ImmichRecent({ item, size }: WidgetProps<ImmichRecentConfig>) {
  const fmt = useFormat();
  const limit = perSize(size, { s: 4, m: 8, t: 12, l: 24, w: 16, x: 40 }, 16);
  const q = useIntegrationWidget("immich", "immich.recent", item.config.integration, { limit, show: item.config.show ?? "all" });
  const src = q.source.state === "ok" ? q.source.ref : null;
  return (
    <Gate kind="immich" source={q.source} q={q} skeleton={<ShelfSkeleton square />}>
      {(d) =>
        d.note ? (
          <Quiet title="Can't show photos">{d.note}</Quiet>
        ) : d.items.length === 0 ? (
          <Quiet title="No photos yet">Photos backed up to Immich appear here, newest first.</Quiet>
        ) : (
          <ul className={l.wall} role="list" data-size={size}>
            {d.items.map((it) => (
              <li key={it.id}>
                <AppLink src={src} className={l.wallLink} title={it.takenAt ? fmt.dateTime(it.takenAt) : undefined}>
                  <Poster src={it.image} title={it.kind === "video" ? "Video" : "Photo"} square />
                  {it.kind === "video" && <Play className={l.wallPlay} aria-label="Video" />}
                </AppLink>
              </li>
            ))}
          </ul>
        )
      }
    </Gate>
  );
}

export function ImmichRecentSettings({ config, onChange }: SettingsProps<ImmichRecentConfig>) {
  return (
    <div className={l.form}>
      <IntegrationPicker kind="immich" value={config.integration} onChange={(integration) => onChange({ ...config, integration })} />
      <Field label="Show">
        <Segmented
          aria-label="Show"
          value={config.show ?? "all"}
          onChange={(show) => onChange({ ...config, show })}
          options={[
            { value: "all", label: "Everything" },
            { value: "photos", label: "Photos" },
            { value: "videos", label: "Videos" },
          ] as const}
        />
      </Field>
      <TitleField config={config} onChange={onChange} placeholder="Latest photos" />
    </div>
  );
}
