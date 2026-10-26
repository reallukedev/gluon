"use client";
import * as React from "react";
import { OpenNewWindow, Download } from "iconoir-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button, LinkButton } from "@/components/ui/Button";
import { DefinitionList } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { OperationProgress } from "@/components/apps/OperationProgress";
import { Disclosure } from "@/components/ui/Disclosure";
import { AppIcon } from "@/components/apps/AppIcon";
import { categoryName, type InstalledInfo, type StoreEntry } from "./types";
import type { InstallRun } from "./StoreView";
import { installedLine } from "./status";
import { listJoin } from "@/lib/format";
import s from "./store.module.css";

interface Props {
  entry: StoreEntry | null;
  /** A deep link to an app no store lists. */
  missingId: string | null;
  installedInfo: (e: StoreEntry) => InstalledInfo | null;
  runs: Record<string, InstallRun>;
  byId: Map<string, StoreEntry>;
  isInstalled: (id: string) => boolean;
  onInstall: (e: StoreEntry) => void;
  onOpenApp: (id: string) => void;
  onClose: () => void;
  /** The app already answering on a port of this server, if any. */
  portUser: (port: number) => { id: string; name: string } | null;
}

/** One app from the store: what it is, what it needs, and Install (or Open and Manage). */
export function AppDialog({ entry, missingId, installedInfo, runs, byId, isInstalled, onInstall, onOpenApp, onClose, portUser }: Props) {
  // Keep the last app on screen while the dialog animates closed.
  const [last, setLast] = React.useState(entry);
  if (entry && entry !== last) setLast(entry);
  const shown = entry ?? last;
  const open = !!entry || !!missingId;

  if (missingId && !entry) {
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title="App not found"
        description={`No store lists an app called “${missingId}”. It may have been renamed or removed.`}
        footer={<Button onClick={onClose}>Close</Button>}
      />
    );
  }
  if (!shown) return null;

  const { app, store } = shown;
  const installed = installedInfo(shown);
  const run = runs[app.id] ?? null;
  const running = !!run?.running;
  const result = run?.state.result ?? null;
  const justInstalled = !!result?.ok;
  const failed = !!result && !result.ok;
  const status = installed ? installedLine(installed) : null;
  const isIn = justInstalled || !!status;

  const deps = app.dependencies.map((id) => ({ id, entry: byId.get(id) ?? null, installed: isInstalled(id) }));
  const missing = deps.filter((d) => !d.installed);
  const missingNames = listJoin(missing.map((d) => d.entry?.app.name ?? d.id));
  const manageHref = `/apps/${encodeURIComponent(app.id)}`;

  let footer: React.ReactNode;
  let footerStart: React.ReactNode = null;
  if (running) {
    footer = (
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    );
  } else if (isIn) {
    footer = (
      <>
        {installed?.url && (
          <Button variant="primary" icon={<OpenNewWindow />} onClick={() => window.open(installed.url!, "_blank", "noopener")}>
            {justInstalled ? `Open ${app.name}` : "Open"}
          </Button>
        )}
        <LinkButton href={manageHref} variant={installed?.url ? "secondary" : "primary"}>
          {justInstalled ? "Go to app" : "Manage"}
        </LinkButton>
      </>
    );
    if (installed?.latest && !justInstalled) footerStart = `${installed.version} is installed; ${installed.latest} is available. Update it from Manage.`;
  } else {
    footerStart = missing.length ? `Install ${missingNames} first.` : null;
    footer = (
      <>
        {failed && (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
        <Button variant="primary" icon={<Download />} disabled={missing.length > 0} onClick={() => onInstall(shown)}>
          {failed ? "Try again" : "Install"}
        </Button>
      </>
    );
  }

  const facts: [React.ReactNode, React.ReactNode][] = [
    [
      "Version",
      <span key="v" className="num">
        {app.version || "Not given"}
        {installed && installed.version && installed.version !== app.version && <span className={s.muted}> ({installed.version} installed)</span>}
      </span>,
    ],
    ["Developer", app.developer || <span className={s.muted}>Not given</span>],
    [
      "Store",
      store.official ? (
        store.name
      ) : (
        <span key="st">
          {store.name}
          <span className={s.factNote}>A community store. Umbrel doesn't review its apps.</span>
        </span>
      ),
    ],
    ["Category", categoryName(app.category)],
  ];
  if (app.website) {
    facts.push([
      "Website",
      <a key="w" href={app.website} target="_blank" rel="noopener noreferrer" className={s.link} title={app.website}>
        {app.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
      </a>,
    ]);
  }
  if (app.port) {
    const taken = !installed ? portUser(app.port) : null;
    facts.push([
      "Port",
      <span key="p">
        <span className="mono">{app.port}</span>
        {taken && taken.id !== app.id && <span className={s.factNote}>{taken.name} already uses this port on this server. Umbrel may refuse to install, or one of them won't open.</span>}
      </span>,
    ]);
  }

  const paragraphs = app.description
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title={
        <span className={s.dialogTitle}>
          <AppIcon src={app.icon} name={app.name} size={44} />
          <span className={s.dialogName}>
            {app.name}
            {status && !running && (
              <span className={s.dialogState}>
                <StateLine state={status.line} size={12} label={status.label} />
              </span>
            )}
          </span>
        </span>
      }
      description={app.tagline || undefined}
      footerStart={footerStart}
      footer={footer}
    >
      <div className={s.detail}>
        {run && (
          <section className={s.installRun} aria-label={`Installing ${app.name}`}>
            <OperationProgress state={run.state} op="install" running={running} />
          </section>
        )}

        <Gallery key={shown.key} images={app.gallery} name={app.name} />

        <div className={s.detailGrid}>
          <div className={s.about}>
            {paragraphs.length ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : <p className={s.muted}>The developer didn't write a description.</p>}
            {app.releaseNotes.trim() && (
              <Disclosure summary={`What's new in ${app.version || "this version"}`}>
                <div className={s.notesBody}>{app.releaseNotes.trim()}</div>
              </Disclosure>
            )}
          </div>
          <div className={s.facts}>
            <DefinitionList items={facts} />
          </div>
        </div>

        {!isIn && !running && (
          <p className={s.how}>
            Umbrel installs it, keeps it up to date and removes it. Once it's installed it shows up in Apps, where Gluon watches it and shows its logs, folders and addresses.
          </p>
        )}

        {deps.length > 0 && (
          <section className={s.deps} aria-labelledby={`deps-${app.id}`}>
            <h3 id={`deps-${app.id}`} className={s.depsTitle}>
              Needs {deps.length === 1 ? "this app" : "these apps"} installed first
            </h3>
            <ul role="list">
              {deps.map((d) => (
                <li key={d.id}>
                  <AppIcon src={d.entry?.app.icon} name={d.entry?.app.name ?? d.id} size={28} />
                  {d.entry ? (
                    <button type="button" className={s.depName} onClick={() => onOpenApp(d.id)}>
                      {d.entry.app.name}
                    </button>
                  ) : (
                    <span className={`${s.depName} mono`}>{d.id}</span>
                  )}
                  <StateLine state={d.installed ? "running" : "stopped"} size={12} label={d.installed ? "Installed" : "Not installed"} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}

/** Screenshots in a sideways strip. Broken images drop out; if none load, the strip goes. */
function Gallery({ images, name }: { images: string[]; name: string }) {
  const [failed, setFailed] = React.useState<ReadonlySet<number>>(() => new Set());
  const shots = images.map((src, i) => ({ src, i })).filter((x) => !failed.has(x.i));
  if (!shots.length) return null;
  return (
    <div className={s.gallery} role="region" aria-label={`Screenshots of ${name}`} tabIndex={0}>
      {shots.map((x) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={x.i}
          src={x.src}
          alt={`${name}, screenshot ${x.i + 1}`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={s.shot}
          onError={() => setFailed((f) => new Set(f).add(x.i))}
        />
      ))}
    </div>
  );
}
