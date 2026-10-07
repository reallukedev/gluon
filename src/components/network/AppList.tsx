"use client";
import * as React from "react";
import { NavArrowRight, Lock, LockSlash, Plus, ArrowRight } from "iconoir-react";
import { Panel, Empty, Skeleton } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { Tooltip } from "@/components/ui/Tooltip";
import { AppIcon } from "@/components/apps/AppIcon";
import type { AppEntry, LoginWords } from "./model";
import { bare, redirectTarget } from "./shared";
import s from "./network.module.css";

/**
 * One row per app on the internet, answering the page's four questions in its columns: which app and
 * at what address, is it working, does a login protect it, and is it on the internet at all.
 */

interface Props {
  entries: AppEntry[] | null;
  baseDomain: string;
  busy: string | null;
  highlight: string | null;
  onOpen: (e: AppEntry) => void;
  onToggle: (e: AppEntry, on: boolean) => void;
  onHomeOnly: (e: AppEntry) => void;
  onMarkLogin: (e: AppEntry) => void;
  onPublish: () => void;
  statusLoading: boolean;
}

export const AppList = React.forwardRef<HTMLElement, Props>(function AppList({ entries, baseDomain, busy, highlight, onOpen, onToggle, onHomeOnly, onMarkLogin, onPublish, statusLoading }, ref) {
  const apps = entries?.filter((e) => !e.isRedirect) ?? [];
  const onCount = apps.filter((e) => e.on).length;
  return (
    <section ref={ref} tabIndex={-1} className={s.listAnchor} aria-labelledby="net-apps-title">
      <Panel
        flush
        title={<span id="net-apps-title">Apps on the internet</span>}
        meta={
          entries ? (
            <span className="num">
              {onCount} of {apps.length} on
            </span>
          ) : undefined
        }
      >
        {!entries ? (
          <div className={s.pad}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={52} radius={8} style={{ marginBottom: 10 }} />
            ))}
          </div>
        ) : entries.length <= 1 && !entries.some((e) => !e.isFallback) ? (
          <>
            {entries.map((e) => (
              <Row key={e.key} e={e} baseDomain={baseDomain} busy={busy === e.key} highlight={highlight === e.key} onOpen={onOpen} onToggle={onToggle} onHomeOnly={onHomeOnly} onMarkLogin={onMarkLogin} statusLoading={statusLoading} />
            ))}
            <Empty title="No other apps on the internet yet" action={<Button icon={<Plus />} onClick={onPublish}>Put an app on the internet</Button>}>
              Give an app an address like photos.{baseDomain} and people can open it from anywhere. Gluon sets up the web server and the certificate; the wildcard DNS record already covers the name.
            </Empty>
          </>
        ) : (
          <div role="table" aria-label="Apps on the internet" className={s.appTable}>
            <div role="row" className={`${s.appHead} ${s.appGrid}`}>
              <span role="columnheader" className={s.colApp}>
                App and address
              </span>
              <span role="columnheader">Working</span>
              <span role="columnheader">Login</span>
              <span role="columnheader" className={s.colSwitch}>
                On the internet
              </span>
              <span role="columnheader" className="sr-only">
                Details
              </span>
            </div>
            <div role="rowgroup">
              {entries.map((e) => (
                <Row key={e.key} e={e} baseDomain={baseDomain} busy={busy === e.key} highlight={highlight === e.key} onOpen={onOpen} onToggle={onToggle} onHomeOnly={onHomeOnly} onMarkLogin={onMarkLogin} statusLoading={statusLoading} />
              ))}
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
});

export function LoginCell({ l }: { l: LoginWords }) {
  if (l.tone === "loading") return <Skeleton width={110} height={12} />;
  if (l.tone === "off") return <span className={s.faint}>Off</span>;
  return (
    <span className={s.login} data-tone={l.tone} title={l.evidence ?? undefined}>
      <span className={s.loginGlyph} aria-hidden>
        {l.tone === "none" ? <LockSlash /> : <Lock />}
      </span>
      <span className={s.loginWords}>
        <span className={s.loginLabel}>{l.label}</span>
        {l.adminTool && <span className={s.cellSub}>admin tool</span>}
      </span>
    </span>
  );
}

function Row({
  e,
  baseDomain,
  busy,
  highlight,
  onOpen,
  onToggle,
  onHomeOnly,
  onMarkLogin,
  statusLoading,
}: {
  e: AppEntry;
  baseDomain: string;
  busy: boolean;
  highlight: boolean;
  onOpen: (e: AppEntry) => void;
  onToggle: (e: AppEntry, on: boolean) => void;
  onHomeOnly: (e: AppEntry) => void;
  onMarkLogin: (e: AppEntry) => void;
  statusLoading: boolean;
}) {
  const main = e.main;
  const url = main.url;
  const also = e.also.filter((a) => a.enabled || !e.on);
  const broken = e.on && e.health.state === "unhealthy";
  return (
    <div className={s.appRowWrap} data-highlight={highlight ? "" : undefined} data-off={e.on ? undefined : ""} id={`net-${e.key}`}>
      <div
        role="row"
        className={`${s.appRow} ${s.appGrid}`}
        onClick={(ev) => {
          if ((ev.target as HTMLElement).closest("a,button,[role=switch]")) return;
          onOpen(e);
        }}
      >
        <span role="cell" className={s.colApp}>
          <span className={s.appIcon}>
            <AppIcon src={e.icon} name={e.name} size={32} />
          </span>
          <span className={s.appMain}>
            <button type="button" className={s.appName} onClick={() => onOpen(e)}>
              {e.name}
            </button>
            <span className={s.addrLine}>
              <a className={s.url} href={url} target="_blank" rel="noopener noreferrer" title={url}>
                {e.isFallback ? baseDomain : bare(url)}
              </a>
              <span className={s.lane}>{e.isRedirect ? (main.route?.type === "subdomain" ? "redirect" : "short link") : main.lane === "direct" ? "direct" : "through Cloudflare"}</span>
            </span>
            {e.isFallback && <span className={s.alsoLine}>Answers anything on {baseDomain} no other address claims</span>}
            {e.isRedirect && redirectTarget(main.route) && (
              <span className={s.alsoLine}>
                <ArrowRight className={s.alsoArrow} aria-hidden /> <span className="mono">{bare(redirectTarget(main.route)!)}</span>
              </span>
            )}
            {also.length > 0 && (
              <span className={s.alsoLine} title={also.map((a) => bare(a.url)).join(", ")}>
                also at{" "}
                {also.map((a, i) => (
                  <React.Fragment key={a.id}>
                    {i > 0 && ", "}
                    <span className="mono">{bare(a.url)}</span>
                  </React.Fragment>
                ))}
              </span>
            )}
            {e.extras.length > 0 && (
              <span className={s.alsoLine} title={e.extras.map((x) => x.note).filter(Boolean).join(" ")}>
                {e.extras.map((x, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && "; "}
                    <span className="mono">{x.paths.slice(0, 2).join(" ")}</span>
                    {x.paths.length > 2 ? ` +${x.paths.length - 2}` : ""} go to {x.app ?? `port ${x.port}`}
                  </React.Fragment>
                ))}
              </span>
            )}
          </span>
        </span>
        <span role="cell" className={s.colWork} title={e.health.sentence || undefined}>
          {e.health.state ? <StateLine state={e.health.state} label={e.health.label} /> : statusLoading ? <Skeleton width={90} height={12} /> : <span className={s.faint}>Not checked</span>}
        </span>
        <span role="cell" className={s.colLogin}>
          <LoginCell l={e.login} />
        </span>
        <span role="cell" className={s.colSwitch}>
          {e.isFallback ? (
            <Tooltip content={`${e.name} answers ${baseDomain} itself, so it's always on. You can change which app answers in its details.`}>
              <span className={s.always} tabIndex={0}>
                Always
              </span>
            </Tooltip>
          ) : (
            <Switch checked={e.on} onChange={(on) => onToggle(e, on)} disabled={busy} aria-label={`${e.name} on the internet`} />
          )}
        </span>
        <span role="cell" className={s.colGo} aria-hidden>
          <NavArrowRight />
        </span>
      </div>

      {broken && (
        <div className={s.fix} data-tone="fault">
          <span className={s.fixMark} aria-hidden />
          <p className={s.fixText}>{e.health.sentence}</p>
          <span className={s.fixActions}>
            {e.appId && !e.isFallback && (
              <LinkButton size="sm" href={`/apps/${encodeURIComponent(e.appId)}`}>
                Open {e.name}
              </LinkButton>
            )}
            <Button size="sm" variant="ghost" onClick={() => onOpen(e)}>
              Details
            </Button>
          </span>
        </div>
      )}
      {e.on && e.needsLogin && (
        <div className={s.fix} data-tone="attention">
          <span className={s.fixMark} aria-hidden />
          <p className={s.fixText}>
            <b>Anyone who finds {bare(url)} can use {e.name}.</b> {e.login.evidence}
          </p>
          <span className={s.fixActions}>
            {!e.isFallback && (
              <Button size="sm" loading={busy} onClick={() => onHomeOnly(e)}>
                Make it home-only
              </Button>
            )}
            {e.appId && (
              <Button size="sm" onClick={() => onMarkLogin(e)}>
                It has a login
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
