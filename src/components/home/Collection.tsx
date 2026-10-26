"use client";
import * as React from "react";
import { Check, Pin, PinSlash, Plus, Search } from "iconoir-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { StateLine, lineLabel } from "@/components/ui/StateLine";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { AppIcon } from "@/components/apps/AppIcon";
import { useApi } from "@/lib/client/api";
import { instanceHints } from "@/lib/app-names";
import { usePrefs } from "@/components/PrefsProvider";
import type { WidgetItem } from "@/lib/home";
import type { Places, Place } from "@/lib/files-types";
import type { AppService, InstalledApp, WidgetCatalog } from "@/lib/widgets-types";
import type { WidgetDef } from "./types";
import type { CollectionSection } from "./context";
import { Preview } from "./previews";
import { ConnectForm, type ConnectTarget } from "./connect/Connect";
import c from "./collection.module.css";

/**
 * The Collection: everything that can live on Home, each with Pin / Unpin. Apps (one card each), folders from
 * Files, widgets by category, and the widgets each installed app offers, under that app. Nothing here needs Home to
 * be in arrange mode: pinning puts the thing on Home straight away, unpinning takes it off.
 */

const CATEGORIES: WidgetDef["category"][] = ["For you", "Household", "Server", "Media & services"];
const BLURB: Partial<Record<WidgetDef["category"], string>> = {
  "For you": "Yours alone: the greeting, search, your links and notes, the weather where you are.",
  Household: "Useful to everyone at home.",
  Server: "How the server is doing, for whoever looks after it.",
  "Media & services": "For apps Gluon can read from that aren't installed here.",
};

/** Home widget ids use kebab-case; the data API uses camelCase ("jellyfin.now-playing" → "jellyfin.nowPlaying"). */
const apiType = (t: string) => t.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

function matches(q: string, ...texts: (string | null | undefined)[]) {
  if (!q) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export interface CollectionProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Which section to show first. */
  section: CollectionSection | null;
  widgets: WidgetDef[];
  items: WidgetItem[];
  onPin: (type: string, config?: Record<string, unknown>) => void;
  /** Take these items off Home (with an Undo toast). */
  onUnpin: (ids: string[]) => void;
}

type View = { step: "browse" } | { step: "connect"; target: ConnectTarget; widget: WidgetDef | null };

export function Collection({ open, onOpenChange, section, widgets, items, onPin, onUnpin }: CollectionProps) {
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const catalog = useApi<WidgetCatalog>(open ? "/api/widgets/catalog" : null, { revalidateOnFocus: false });
  const places = useApi<Places>(open ? "/api/files/places" : null, { revalidateOnFocus: false });
  const [view, setView] = React.useState<View>({ step: "browse" });
  const [query, setQuery] = React.useState("");
  const q = query.trim();

  // Start each visit clean, at the section asked for.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setView({ step: "browse" });
    }
  }
  React.useEffect(() => {
    if (!open || !section) return;
    const t = setTimeout(() => document.getElementById(`collection-${section}`)?.scrollIntoView({ block: "start" }), 60);
    return () => clearTimeout(t);
  }, [open, section]);

  const close = (o: boolean) => onOpenChange(o);
  const onHome = (type: string, match?: (i: WidgetItem) => boolean) => items.filter((i) => i.type === type && (!match || match(i)));

  const apps = catalog.data?.apps ?? [];
  const openable = apps.filter((a) => a.urls.home || a.urls.away);
  const hints = instanceHints(apps.map((a) => ({ id: a.appId, name: a.name, source: a.source })));
  const withServices = apps.filter((a) => a.services.length > 0 && !a.duplicate);
  const kindsHere = new Set(withServices.flatMap((a) => a.services.map((sv) => sv.kind)));
  const unavailable = new Set((catalog.data?.types ?? []).filter((t) => !t.available).map((t) => t.type as string));
  const local = new Map((catalog.data?.local ?? []).map((l) => [l.type, l]));

  const shownApps = openable.filter((a) => matches(q, a.name, hints.get(a.appId), "app"));
  const folderList = React.useMemo(() => {
    const d = places.data;
    if (!d) return [] as Place[];
    const seen = new Set<string>();
    const out: Place[] = [];
    for (const p of [...d.pins, ...d.places]) {
      if (seen.has(p.path) || p.missing) continue;
      seen.add(p.path);
      out.push(p);
    }
    return out;
  }, [places.data]);
  const shownFolders = folderList.filter((p) => matches(q, p.label, p.path, p.detail, "folder files"));
  const general = widgets.filter((w) => !w.hidden && !w.perApp && !(w.kind && kindsHere.has(w.kind)) && (admin || !unavailable.has(apiType(w.type))));
  const groups = CATEGORIES.map((cat) => ({ cat, list: general.filter((w) => w.category === cat && matches(q, w.name, w.description, w.category, w.keywords)) })).filter((g) => g.list.length);
  const appBlocks = withServices
    .map((app) => ({ app, list: app.services.flatMap((sv) => widgets.filter((w) => w.kind === sv.kind).map((w) => ({ sv, w }))) }))
    .map((b) => ({ ...b, list: b.list.filter(({ sv, w }) => matches(q, b.app.name, sv.label, w.name, w.description)) }))
    .filter((b) => b.list.length);
  const loading = !catalog.data && !catalog.error;
  const nothing = !!q && !loading && !shownApps.length && !shownFolders.length && !groups.length && !appBlocks.length;

  if (view.step === "connect") {
    const { target, widget } = view;
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title={`${target.integrationId ? "Reconnect" : "Connect"} ${target.service.label}`}
        description={widget ? `Then “${widget.name}” goes on your Home, live.` : `Its widgets then work for you${target.integrationId ? "" : " and anyone you share it with"}.`}
      >
        <ConnectForm
          key={target.service.key}
          target={target}
          cancelLabel="Back"
          onCancel={() => setView({ step: "browse" })}
          onConnected={(r) => {
            if (widget) onPin(widget.type, { integration: r.integrationId });
            setView({ step: "browse" });
            void catalog.mutate();
          }}
        />
      </Dialog>
    );
  }

  const jump = (id: CollectionSection) => document.getElementById(`collection-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });

  return (
    <Dialog open={open} onOpenChange={close} title="Collection" description="Everything that can live on your Home. Pin what you want; unpin it here or right on Home." size="xwide">
      <div className={c.collection}>
        <div className={c.bar}>
          <div className={c.search}>
            <Search className={c.searchIcon} aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find something to pin: photos, a folder, the weather…"
              aria-label="Find something to pin"
              autoComplete="off"
              className={c.searchInput}
            />
          </div>
          {!q && (
            <nav className={c.jumps} aria-label="Sections">
              <button type="button" onClick={() => jump("apps")}>
                Apps
              </button>
              <button type="button" onClick={() => jump("folders")}>
                Folders
              </button>
              <button type="button" onClick={() => jump("widgets")}>
                Widgets
              </button>
              {withServices.length > 0 && (
                <button type="button" onClick={() => jump("from-apps")}>
                  From your apps
                </button>
              )}
            </nav>
          )}
        </div>

        {nothing && (
          <p className={c.none} role="status">
            Nothing matches “{q}”. Try a plainer word, like “photos”, “music” or “disk”.
          </p>
        )}

        {/* ---------------------------------------------------------------- apps */}
        {(!q || shownApps.length > 0) && (
          <section className={c.section} id="collection-apps" aria-labelledby="collection-apps-title">
            <div className={c.head}>
              <h3 id="collection-apps-title" className={c.title}>
                Apps
              </h3>
              <p className={c.sub}>Each pinned app gets its own card on Home. Change its size from the card&apos;s menu.</p>
            </div>
            {catalog.error && !catalog.data ? (
              <Notice tone="fault" title="Couldn't load your apps" action={<Button size="sm" onClick={() => void catalog.mutate()}>Try again</Button>}>
                {catalog.error.message}
              </Notice>
            ) : loading ? (
              <div className={c.grid} aria-busy="true" aria-label="Loading your apps">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} height={132} radius={10} />
                ))}
              </div>
            ) : shownApps.length ? (
              <ul className={c.appGrid} role="list">
                {shownApps.map((a) => {
                  const pinned = onHome("app", (i) => i.config.appId === a.appId);
                  const hint = hints.get(a.appId);
                  const on = pinned.length > 0;
                  return (
                    <li key={a.appId} className={c.appEntry} data-pinned={on ? "" : undefined}>
                      <button
                        type="button"
                        className={c.appToggle}
                        aria-pressed={on}
                        aria-label={on ? `Unpin ${a.name}` : `Pin ${a.name}`}
                        onClick={() => (on ? onUnpin(pinned.map((i) => i.id)) : onPin("app", { appId: a.appId, name: a.name }))}
                      >
                        <span className={c.appPin} aria-hidden>
                          {on ? <Check /> : <Pin />}
                        </span>
                        <AppIcon src={a.icon} name={a.name} size={44} />
                        <span className={c.appName}>{a.name}</span>
                        <span className={c.appSub}>
                          {a.line !== "running" && <StateLine state={a.line} size={9} />}
                          {a.line !== "running" ? a.summary || lineLabel(a.line) : (hint ?? (on ? "On Home" : "Pin to Home"))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={c.empty}>{admin ? "No apps with a web page yet. Install one in Apps, or give an app a public address." : "No apps are shared with you yet. Ask whoever runs the server."}</p>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- folders */}
        {(!q || shownFolders.length > 0) && (
          <section className={c.section} id="collection-folders" aria-labelledby="collection-folders-title">
            <div className={c.head}>
              <h3 id="collection-folders-title" className={c.title}>
                Folders
              </h3>
              <p className={c.sub}>{admin ? "Pinned folders from Files, drives and home folders: a shortcut that opens it in Files." : "Folders shared with you, and the ones you pinned in Files."}</p>
            </div>
            {places.error && !places.data ? (
              <Notice tone="fault" title="Couldn't load your folders" action={<Button size="sm" onClick={() => void places.mutate()}>Try again</Button>}>
                {places.error.message}
              </Notice>
            ) : !places.data ? (
              <div className={c.grid} aria-busy="true" aria-label="Loading folders">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} height={132} radius={10} />
                ))}
              </div>
            ) : shownFolders.length ? (
              <ul className={c.grid} role="list">
                {shownFolders.map((p) => {
                  const pinned = onHome("folder", (i) => i.config.path === p.path);
                  return (
                    <Entry
                      key={p.id}
                      name={p.label}
                      preview={<Preview of="folder" />}
                      detail={<span className="mono truncate">{p.path}</span>}
                      title={p.path}
                      pinned={pinned.length > 0}
                      onPin={() => onPin("folder", { path: p.path, label: p.label })}
                      onUnpin={() => onUnpin(pinned.map((i) => i.id))}
                    />
                  );
                })}
              </ul>
            ) : (
              <p className={c.empty}>{admin ? "Pin a folder in Files and it shows up here." : "Nothing is shared with you in Files yet."}</p>
            )}
          </section>
        )}

        {/* ---------------------------------------------------------------- widgets */}
        <div id="collection-widgets" className={c.widgets}>
          {groups.map((g) => (
            <section key={g.cat} className={c.section} aria-labelledby={`collection-cat-${g.cat.replace(/\W+/g, "-")}`}>
              <div className={c.head}>
                <h3 id={`collection-cat-${g.cat.replace(/\W+/g, "-")}`} className={c.title}>
                  {g.cat}
                </h3>
                {!q && BLURB[g.cat] && <p className={c.sub}>{BLURB[g.cat]}</p>}
              </div>
              <ul className={c.grid} role="list">
                {g.list.map((w) => {
                  const here = local.get(w.type);
                  const reason = here && !here.available ? (here.reason ?? "Not available on this server.") : unavailable.has(apiType(w.type)) ? "Connect the app it reads from first, in Settings → Connected apps." : null;
                  const pinned = onHome(w.type);
                  return (
                    <Entry
                      key={w.type}
                      name={w.name}
                      preview={w.preview}
                      detail={w.description}
                      reason={reason}
                      pinned={pinned.length > 0}
                      count={pinned.length}
                      multiple={w.multiple}
                      onPin={() => onPin(w.type)}
                      onUnpin={() => onUnpin(pinned.map((i) => i.id))}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        {/* ---------------------------------------------------------------- per app */}
        {appBlocks.length > 0 && (
          <section className={c.section} id="collection-from-apps" aria-labelledby="collection-from-apps-title">
            <div className={c.head}>
              <h3 id="collection-from-apps-title" className={c.title}>
                From your apps
              </h3>
              <p className={c.sub}>
                {admin ? "What installed apps can show on Home. Connect an app once and its widgets work for everyone you share it with." : "What your apps can show on Home."}
              </p>
            </div>
            <div className={c.blocks}>
              {appBlocks.map(({ app, list }) => (
                <AppBlock
                  key={app.appId}
                  app={app}
                  hint={hints.get(app.appId) ?? null}
                  admin={admin}
                  onConnect={(sv, w) => setView({ step: "connect", target: targetOf(app, sv), widget: w })}
                >
                  <ul className={c.grid} role="list">
                    {list.map(({ sv, w }) => {
                      const pinned = onHome(w.type, (i) => !i.config.integration || i.config.integration === sv.integrationId);
                      const needs = sv.state === "none";
                      return (
                        <Entry
                          key={`${sv.key}:${w.type}`}
                          name={app.services.length > 1 ? `${sv.label} · ${w.name}` : w.name}
                          preview={w.preview}
                          detail={w.description}
                          pinned={pinned.length > 0}
                          count={pinned.length}
                          multiple={w.multiple}
                          reason={needs && !(admin && sv.connect) ? `${sv.label} isn't connected yet. Whoever runs the server can connect it.` : null}
                          pinLabel={needs && admin && sv.connect ? "Connect and pin" : undefined}
                          onPin={() => (needs && admin && sv.connect ? setView({ step: "connect", target: targetOf(app, sv), widget: w }) : onPin(w.type, sv.integrationId ? { integration: sv.integrationId } : undefined))}
                          onUnpin={() => onUnpin(pinned.map((i) => i.id))}
                        />
                      );
                    })}
                  </ul>
                </AppBlock>
              ))}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function targetOf(app: InstalledApp, sv: AppService): ConnectTarget {
  return { appId: app.appId, appName: app.name, icon: app.icon, line: app.line, service: sv, integrationId: sv.state === "broken" ? sv.integrationId : null };
}

/** One thing that can be pinned: a drawing of it, its name, one line, and the button. */
function Entry({
  name,
  preview,
  detail,
  title,
  reason,
  pinned,
  count = 0,
  multiple,
  pinLabel,
  onPin,
  onUnpin,
}: {
  name: string;
  preview: React.ReactNode;
  detail: React.ReactNode;
  title?: string;
  /** Why it can't be pinned here; replaces the button. */
  reason?: string | null;
  pinned: boolean;
  count?: number;
  multiple?: boolean;
  pinLabel?: string;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const off = !!reason && !pinned;
  return (
    <li className={c.entry} data-pinned={pinned ? "" : undefined} data-off={off ? "" : undefined} title={title}>
      <span className={c.preview} aria-hidden>
        {preview}
      </span>
      <span className={c.name}>
        <span className="truncate">{name}</span>
        {pinned && (
          <span className={c.onHome}>
            <Check aria-hidden />
            {count > 1 ? `On Home ×${count}` : "On Home"}
          </span>
        )}
      </span>
      <span className={c.detail}>{off ? reason : detail}</span>
      <span className={c.actions}>
        {off ? (
          <span className={c.offWord}>Not available here</span>
        ) : pinned ? (
          <>
            <Button size="sm" variant="ghost" icon={<PinSlash />} onClick={onUnpin} aria-label={count > 1 ? `Unpin all ${count} ${name}` : `Unpin ${name}`}>
              {count > 1 ? `Unpin all ${count}` : "Unpin"}
            </Button>
            {multiple && (
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={onPin} aria-label={`Pin another ${name}`}>
                Another
              </Button>
            )}
          </>
        ) : (
          <Button size="sm" icon={<Pin />} onClick={onPin} aria-label={`${pinLabel ?? "Pin"} ${name}`}>
            {pinLabel ?? "Pin"}
          </Button>
        )}
      </span>
    </li>
  );
}

function AppBlock({
  app,
  hint,
  admin,
  onConnect,
  children,
}: {
  app: InstalledApp;
  hint: string | null;
  admin: boolean;
  onConnect: (sv: AppService, w: WidgetDef | null) => void;
  children: React.ReactNode;
}) {
  const many = app.services.length > 1;
  return (
    <section className={c.block} aria-label={app.name}>
      <div className={c.blockHead}>
        <span className={c.blockIcon} data-stopped={app.line === "stopped" ? "" : undefined}>
          <AppIcon src={app.icon} name={app.name} size={32} />
        </span>
        <div className={c.blockText}>
          <span className={c.blockName}>
            <span className="truncate">{app.name}</span>
            {hint && <span className={c.blockHint}>{hint}</span>}
          </span>
          <span className={c.blockState}>
            <StateLine state={app.line} size={10} />
            {app.line === "running" ? "Running" : app.summary || lineLabel(app.line)}
          </span>
        </div>
        {admin && (
          <ul className={c.services} role="list">
            {app.services.map((sv) => (
              <li key={sv.key} className={c.service}>
                {many && <span className={c.serviceName}>{sv.label}</span>}
                {sv.state === "connected" ? (
                  <span className={c.conn}>
                    <StateLine state="running" size={10} />
                    Connected
                  </span>
                ) : sv.state === "broken" ? (
                  <span className={c.conn} data-fault="" title={sv.message ?? undefined}>
                    <StateLine state="unhealthy" size={10} />
                    Not working
                  </span>
                ) : (
                  <span className={c.conn}>Not connected</span>
                )}
                {sv.state !== "connected" && sv.connect && (
                  <Button size="sm" onClick={() => onConnect(sv, null)}>
                    {sv.state === "broken" ? "Reconnect" : "Connect"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </section>
  );
}
