"use client";
import * as React from "react";
import { mutate } from "swr";
import { ArrowUpRight, Play } from "iconoir-react";
import type { WidgetProps } from "./types";
import type { AppConfig, ApiApp } from "./widgets/app";
import { Vitals, appHints, hostOf, uptimeOf } from "./widgets/app";
import { useSmartUrl } from "./widgets/core";
import { SetUp, WidgetState } from "./widgets/kit";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { shortName } from "@/lib/app-names";
import c from "./appCard.module.css";

/**
 * One pinned app, as its own card on Home. The whole card opens the app; everything else (unpin,
 * size, which address) lives in the item's menu. A running app says nothing about its state, since
 * that's the normal case; only starting, stopped, broken or needs-you apps show their line.
 *
 *   i  Icon  the app's icon and name, like a home screen
 *   c  Row   icon, name and a quiet second line on one row
 *   s  Card  adds live CPU and memory (admins) or what the app is for (household)
 *   m  Wide  adds where it opens, at home and from anywhere
 */

type Line = ApiApp["line"];

const QUIET: Line[] = ["running"];
const WORD: Partial<Record<Line, string>> = { stopped: "Stopped", unhealthy: "Not working", starting: "Starting", attention: "Needs you", paused: "Paused", unknown: "Unknown" };

function stateWord(app: ApiApp): string | null {
  if (QUIET.includes(app.line)) return null;
  if (app.line === "unhealthy" || app.line === "attention") return app.summary || WORD[app.line]!;
  return WORD[app.line] ?? app.summary;
}

const ICON: Record<string, number> = { i: 64, c: 40, s: 44, m: 44 };

export function AppCardWidget({ item, size, openSettings, editing }: WidgetProps<AppConfig> & { openSettings?: () => void }) {
  const { data, error } = useApi<ApiApp[]>("/api/apps", { refresh: 20_000 });
  const { viewer, prefs, serverName } = usePrefs();
  const url = useSmartUrl();
  const [starting, setStarting] = React.useState(false);
  const appId = item.config.appId;
  const admin = viewer.role === "admin";
  const px = ICON[size] ?? 44;

  if (!appId) {
    return (
      <WidgetState title="Which app?" action={<SetUp openSettings={openSettings}>Pick an app</SetUp>}>
        This card opens one app.
      </WidgetState>
    );
  }
  if (!data) {
    if (error) {
      return (
        <div className={c.card} data-size={size} data-state="unknown">
          <span className={c.icon}>
            <AppIcon src={null} name={item.config.name ?? "?"} size={px} />
          </span>
          <span className={c.text}>
            <span className={c.name}>{item.config.name ?? "App"}</span>
            <span className={c.sub}>{admin ? error.message : "Can't check it right now"}</span>
          </span>
        </div>
      );
    }
    return (
      <div className={c.card} data-size={size} aria-busy="true" aria-label={item.config.name ? `Loading ${item.config.name}` : "Loading app"}>
        <span className={c.icon}>
          <Skeleton width={px} height={px} radius={Math.round(px * 0.24)} />
        </span>
        <span className={c.text}>
          <Skeleton width={size === "i" ? 64 : "55%"} height={12} />
          {size !== "i" && <Skeleton width="35%" height={10} />}
        </span>
      </div>
    );
  }

  const app = data.find((a) => a.id === appId);
  if (!app) {
    return (
      <div className={c.card} data-size={size} data-state="gone">
        <span className={c.icon}>
          <AppIcon src={null} name={item.config.name ?? "?"} size={px} />
        </span>
        <span className={c.text}>
          <span className={c.name}>{item.config.name ?? "This app"}</span>
          <span className={c.sub}>{admin ? "Removed from the server" : "Not shared with you any more"}</span>
        </span>
      </div>
    );
  }

  const hint = appHints(data).get(app.id) ?? null;
  const name = shortName(app.name, serverName);
  const href = url(app.urls);
  const target = prefs.openLinks === "new" ? "_blank" : undefined;
  const stopped = app.line === "stopped";
  const word = stateWord(app);
  const uptime = !stopped ? uptimeOf(app) : null;
  const homeHost = hostOf(app.urls.home);
  const awayHost = hostOf(app.urls.away);
  const big = size === "s" || size === "m";
  const showVitals = big && admin && !stopped && !!app.containers?.length;

  async function start(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setStarting(true);
    try {
      await api.post(`/api/apps/${encodeURIComponent(app!.id)}/action`, { action: "start" });
      toast.success(`Starting ${app!.name}`);
      await mutate("/api/apps");
    } catch (err) {
      toast.error(`Couldn't start ${app!.name}`, { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setStarting(false);
    }
  }

  // Second line: what's wrong if anything, else which copy it is, else (bigger sizes) how long it's been up.
  const sub = word ?? hint ?? (size === "c" || big ? (uptime ? `Up ${uptime}` : null) : null);
  const label = `Open ${app.name}${hint ? ` (${hint})` : ""}${word ? `. ${word}` : ""}`;

  const face = (
    <>
      <span className={c.icon}>
        <AppIcon src={app.icon} name={app.name} size={px} />
      </span>
      <span className={c.text}>
        <span className={c.name} title={app.name}>
          {name}
        </span>
        {sub && (
          <span className={c.sub}>
            {word && <StateLine state={app.line} size={size === "i" ? 9 : 10} />}
            <span className={c.subText}>{sub}</span>
          </span>
        )}
      </span>
      {href && size !== "i" && (
        <span className={c.go} aria-hidden>
          <ArrowUpRight />
        </span>
      )}
    </>
  );

  const body = big ? (
    <div className={c.more}>
      {stopped ? (
        <div className={c.stopped}>
          <p>{admin ? "Stopped, so it can't be opened." : "Stopped right now. Whoever runs the server can start it."}</p>
          {admin && (
            <Button size="sm" icon={<Play />} loading={starting} onClick={(e) => void start(e)}>
              Start {name}
            </Button>
          )}
        </div>
      ) : showVitals ? (
        <Vitals app={app} name={app.name} />
      ) : app.description ? (
        <p className={c.description}>{app.description}</p>
      ) : null}
      {size === "m" && (homeHost || awayHost) && (
        <dl className={c.where}>
          {homeHost && (
            <div>
              <dt>At home</dt>
              <dd className="mono" title={app.urls.home ?? undefined}>
                {homeHost}
              </dd>
            </div>
          )}
          {awayHost && (
            <div>
              <dt>Anywhere</dt>
              <dd className="mono" title={app.urls.away ?? undefined}>
                {awayHost}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  ) : null;

  const state = app.line;
  // No address: nothing to open, so the card is information, not a link.
  if (!href || editing) {
    return (
      <div className={c.card} data-size={size} data-state={state} data-static="">
        <div className={c.face}>{face}</div>
        {body}
        {!href && !editing && size === "i" && <span className={c.nolink}>No web page</span>}
      </div>
    );
  }
  return (
    <a className={c.card} data-size={size} data-state={state} href={href} target={target} rel="noopener noreferrer" aria-label={label} title={hint ? `${app.name} · ${hint}` : app.name}>
      <span className={c.face}>{face}</span>
      {body}
    </a>
  );
}

/** Catalog / Collection preview: the Icon card in miniature. */
export function AppCardPreview({ icon, name }: { icon?: string | null; name?: string }) {
  return (
    <span className={c.preview} aria-hidden>
      <AppIcon src={icon ?? null} name={name ?? "App"} size={26} />
      <span className={c.previewName}>{name ?? "App"}</span>
    </span>
  );
}
