"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { StateLine, lineLabel } from "@/components/ui/StateLine";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { AppIcon } from "@/components/apps/AppIcon";
import { SIZES, type WidgetItem } from "@/lib/home";
import { useApi } from "@/lib/client/api";
import { instanceHints } from "@/lib/app-names";
import { usePrefs } from "@/components/PrefsProvider";
import type { AppService, InstalledApp, WidgetCatalog } from "@/lib/widgets-types";
import type { WidgetDef } from "./types";
import { AppPreview } from "./widgets/app";
import { ConnectForm, type ConnectTarget } from "./connect/Connect";
import s from "./catalog.module.css";

const ORDER: WidgetDef["category"][] = ["For you", "Apps", "Server", "Media & services"];

/** Home widget ids use kebab-case; the data API uses camelCase ("jellyfin.now-playing" → "jellyfin.nowPlaying"). */
const apiType = (t: string) => t.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

type View = { step: "browse" } | { step: "connect"; target: ConnectTarget; widget: WidgetDef | null };

export interface CatalogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Add a widget; `config` is merged over its defaults. */
  onAdd: (type: string, config?: Record<string, unknown>) => void;
  widgets: WidgetDef[];
  existing: WidgetItem[];
}

export function Catalog({ open, onOpenChange, onAdd, widgets, existing }: CatalogProps) {
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const {
    data: catalog,
    error,
    mutate,
  } = useApi<WidgetCatalog>(open ? "/api/widgets/catalog" : null, {
    revalidateOnFocus: false,
  });
  const [view, setView] = React.useState<View>({ step: "browse" });

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setView({ step: "browse" });
  };

  const perApp = widgets.find((w) => w.perApp);
  const apps = catalog?.apps ?? [];
  const withServices = apps.filter((a) => a.services.length > 0 && !a.duplicate);
  const others = apps.filter((a) => a.services.length === 0 || a.duplicate);
  const hints = instanceHints(apps.map((a) => ({ id: a.appId, name: a.name, source: a.source })));
  // Integration widgets for kinds an installed app provides live under that app; the rest stay in their category.
  const kindsHere = new Set(withServices.flatMap((a) => a.services.map((sv) => sv.kind)));
  const unavailable = new Set((catalog?.types ?? []).filter((t) => !t.available).map((t) => t.type as string));
  const general = widgets.filter((w) => !w.perApp && !(w.kind && kindsHere.has(w.kind)) && (admin || !unavailable.has(apiType(w.type))));
  const groups = ORDER.map((cat) => ({
    cat,
    items: general.filter((w) => w.category === cat),
  })).filter((g) => g.items.length);

  const countOf = (type: string, match?: (i: WidgetItem) => boolean) => existing.filter((i) => i.type === type && (!match || match(i))).length;

  function pick(app: InstalledApp, sv: AppService, w: WidgetDef) {
    if (sv.integrationId && sv.state !== "none") {
      onAdd(w.type, { integration: sv.integrationId });
      return;
    }
    if (admin && sv.connect) setView({ step: "connect", target: targetOf(app, sv), widget: w });
  }

  if (view.step === "connect") {
    const { target, widget } = view;
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title={`${target.integrationId ? "Reconnect" : "Connect"} ${target.service.label}`}
        description={
          widget ? `Then “${widget.name}” goes on your home page, live.` : `Its widgets then work for you${target.integrationId ? "" : " and anyone you share it with"}.`
        }
      >
        <ConnectForm
          key={target.service.key}
          target={target}
          cancelLabel="Back"
          onCancel={() => setView({ step: "browse" })}
          onConnected={(r) => {
            if (widget) onAdd(widget.type, { integration: r.integrationId });
            else {
              setView({ step: "browse" });
              void mutate();
            }
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close} title="Add a widget" description="It goes at the top of your home page. Drag it anywhere after." size="xwide">
      <div className={s.catalog}>
        <section className={s.group} aria-labelledby="cat-apps">
          <div className={s.groupHead}>
            <h3 id="cat-apps" className={s.groupTitle}>
              From your apps
            </h3>
            <p className={s.groupSub}>
              {admin
                ? "Everything installed on this server. Connect an app once and its widgets work for everyone you share it with."
                : "The apps you can open, with what they're doing."}
            </p>
          </div>
          {error && !catalog ? (
            <Notice
              tone="fault"
              title="Couldn't load your apps"
              action={
                <Button size="sm" onClick={() => void mutate()}>
                  Try again
                </Button>
              }
            >
              {error.message}
            </Notice>
          ) : !catalog ? (
            <div className={s.appBlocks} aria-busy="true" aria-label="Loading your apps">
              {[0, 1, 2].map((i) => (
                <div key={i} className={s.appBlock}>
                  <div className={s.appHead}>
                    <Skeleton width={36} height={36} radius={9} />
                    <div style={{ display: "grid", gap: 6 }}>
                      <Skeleton width={120} height={13} />
                      <Skeleton width={80} height={11} />
                    </div>
                  </div>
                  <div className={s.cards}>
                    {[0, 1, 2].map((j) => (
                      <Skeleton key={j} height={118} radius={10} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {withServices.length > 0 && (
                <div className={s.appBlocks}>
                  {withServices.map((app) => (
                    <AppBlock
                      key={app.appId}
                      app={app}
                      hint={hints.get(app.appId) ?? null}
                      admin={admin}
                      widgets={widgets}
                      perApp={perApp}
                      countOf={countOf}
                      onAddApp={() => perApp && onAdd(perApp.type, { appId: app.appId, name: app.name })}
                      onPick={(sv, w) => pick(app, sv, w)}
                      onConnect={(sv) =>
                        setView({
                          step: "connect",
                          target: targetOf(app, sv),
                          widget: null,
                        })
                      }
                    />
                  ))}
                </div>
              )}
              {perApp && others.length > 0 && (
                <div className={s.others}>
                  <p className={s.othersTitle}>
                    {withServices.length ? "Every other app" : null}
                    <span>
                      A tile with its state
                      {admin ? ", live CPU and memory" : ""} and a button to open it.
                    </span>
                  </p>
                  <ul className={s.chips} role="list">
                    {others.map((app) => {
                      const on = countOf(perApp.type, (i) => i.config.appId === app.appId);
                      const hint = hints.get(app.appId);
                      return (
                        <li key={app.appId}>
                          <button type="button" className={s.chip} onClick={() => onAdd(perApp.type, { appId: app.appId, name: app.name })} data-line={app.line}>
                            <AppIcon src={app.icon} name={app.name} size={24} />
                            <span className={s.chipText}>
                              <span className="truncate">{app.name}</span>
                              <span className={s.chipMeta}>
                                <StateLine state={app.line} size={9} />
                                {hint ? `${hint} · ` : ""}
                                {on ? "On your page" : lineLabel(app.line)}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {apps.length === 0 && (
                <p className={s.groupSub}>
                  {admin ? "No apps are installed yet. Install one from Apps, and it shows up here." : "No apps are shared with you yet. Ask whoever runs the server."}
                </p>
              )}
            </>
          )}
        </section>

        {groups.map((g) => (
          <section key={g.cat} className={s.group} aria-labelledby={`cat-${g.cat}`}>
            <div className={s.groupHead}>
              <h3 id={`cat-${g.cat}`} className={s.groupTitle}>
                {g.cat}
              </h3>
            </div>
            <div className={s.cards}>
              {g.items.map((w) => (
                <Card
                  key={w.type}
                  def={w}
                  onClick={() => onAdd(w.type)}
                  meta={
                    countOf(w.type) ? `On your page${countOf(w.type) > 1 ? ` ×${countOf(w.type)}` : ""}` : unavailable.has(apiType(w.type)) ? "Needs a connected app" : undefined
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function targetOf(app: InstalledApp, sv: AppService): ConnectTarget {
  return {
    appId: app.appId,
    appName: app.name,
    icon: app.icon,
    line: app.line,
    service: sv,
    integrationId: sv.state === "broken" ? sv.integrationId : null,
  };
}

function AppBlock({
  app,
  hint,
  admin,
  widgets,
  perApp,
  countOf,
  onAddApp,
  onPick,
  onConnect,
}: {
  app: InstalledApp;
  hint: string | null;
  admin: boolean;
  widgets: WidgetDef[];
  perApp: WidgetDef | undefined;
  countOf: (type: string, match?: (i: WidgetItem) => boolean) => number;
  onAddApp: () => void;
  onPick: (sv: AppService, w: WidgetDef) => void;
  onConnect: (sv: AppService) => void;
}) {
  const many = app.services.length > 1;
  const appOnPage = perApp ? countOf(perApp.type, (i) => i.config.appId === app.appId) : 0;
  return (
    <section className={s.appBlock} aria-label={app.name}>
      <div className={s.appHead}>
        <span className={s.appIcon} data-stopped={app.line === "stopped" ? "" : undefined}>
          <AppIcon src={app.icon} name={app.name} size={36} />
        </span>
        <div className={s.appText}>
          <span className={s.appName}>
            <span className="truncate">{app.name}</span>
            {hint && <span className={s.appHint}>{hint}</span>}
          </span>
          <span className={s.appState}>
            <StateLine state={app.line} size={10} />
            {app.line === "running" ? "Running" : app.summary || lineLabel(app.line)}
          </span>
        </div>
        {admin && (
          <ul className={s.services} role="list">
            {app.services.map((sv) => (
              <li key={sv.key} className={s.service}>
                {many && <span className={s.serviceName}>{sv.label}</span>}
                <ConnState sv={sv} />
                {sv.state === "none" && sv.connect && (
                  <Button size="sm" onClick={() => onConnect(sv)}>
                    Connect
                  </Button>
                )}
                {sv.state === "broken" && sv.connect && (
                  <Button size="sm" onClick={() => onConnect(sv)}>
                    Reconnect
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={s.cards}>
        {perApp && (
          <Card
            def={perApp}
            preview={<AppPreview icon={app.icon} name={app.name} />}
            name={`${app.name} tile`}
            description={admin ? "Its state, live CPU and memory, and a button to open it." : "Whether it's running, and a button to open it."}
            onClick={onAddApp}
            meta={appOnPage ? "On your page" : undefined}
          />
        )}
        {app.services.flatMap((sv) =>
          widgets
            .filter((w) => w.kind === sv.kind)
            .map((w) => {
              const on = countOf(w.type, (i) => !i.config.integration || i.config.integration === sv.integrationId);
              const needs = sv.state === "none";
              return (
                <Card
                  key={`${sv.key}:${w.type}`}
                  def={w}
                  onClick={() => onPick(sv, w)}
                  service={many ? sv.label : undefined}
                  pending={needs}
                  meta={needs ? "Connect, then add" : on ? "On your page" : undefined}
                />
              );
            }),
        )}
      </div>
    </section>
  );
}

function ConnState({ sv }: { sv: AppService }) {
  if (sv.state === "connected") {
    return (
      <span className={s.conn}>
        <StateLine state="running" size={10} />
        Connected
      </span>
    );
  }
  if (sv.state === "broken") {
    return (
      <span className={s.conn} data-fault="" title={sv.message ?? undefined}>
        <StateLine state="unhealthy" size={10} />
        Not working
      </span>
    );
  }
  return <span className={s.conn}>Not connected</span>;
}

function Card({
  def,
  onClick,
  meta,
  preview,
  name,
  description,
  service,
  pending,
}: {
  def: WidgetDef;
  onClick: () => void;
  meta?: string;
  preview?: React.ReactNode;
  name?: string;
  description?: string;
  service?: string;
  pending?: boolean;
}) {
  return (
    <button type="button" className={s.card} onClick={onClick} data-pending={pending ? "" : undefined}>
      <span className={s.preview} aria-hidden>
        {preview ?? def.preview}
      </span>
      <span className={s.cardName}>
        {service && <span className={s.svc}>{service} ·</span>}
        {name ?? def.name}
      </span>
      <span className={s.cardDesc}>{description ?? def.description}</span>
      <span className={s.cardMeta}>{meta ?? def.sizes.map((z) => SIZES[z].label).join(" · ")}</span>
    </button>
  );
}
