"use client";
import * as React from "react";
import type { AppUse, FileJob, OwnershipPreview } from "@/lib/files-types";
import { api, streamPost, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Field } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { Disclosure } from "@/components/ui/Disclosure";
import s from "./files.module.css";

interface AppLite {
  id: string;
  name: string;
}

type Phase = { kind: "choose" } | { kind: "checking"; done: number; toChange: number } | { kind: "ready"; preview: OwnershipPreview } | { kind: "error"; message: string };

/**
 * "Fix ownership for an app": pick the app, count what would change (streamed), confirm, then run
 * it as a background task. The task keeps a record so it can be undone from the tray.
 */
export function Ownership({ path, onClose, onStarted }: { path: string | null; onClose: () => void; onStarted: (job: FileJob) => void }) {
  const fmt = useFormat();
  const { data: used } = useApi<{ uses: AppUse[] }>(path ? `/api/files/used-by?path=${encodeURIComponent(path)}` : null);
  const { data: allApps } = useApi<AppLite[]>(path ? "/api/apps" : null);
  const [app, setApp] = React.useState<string>("");
  const [phase, setPhase] = React.useState<Phase>({ kind: "choose" });
  const [busy, setBusy] = React.useState(false);
  const abort = React.useRef<AbortController | null>(null);

  const users = React.useMemo(() => {
    const seen = new Map<string, AppUse>();
    for (const u of used?.uses ?? []) if (!seen.has(u.appId)) seen.set(u.appId, u);
    return [...seen.values()];
  }, [used]);

  React.useEffect(() => {
    if (!path) return;
    setPhase({ kind: "choose" });
    setApp("");
  }, [path]);
  React.useEffect(() => {
    if (!app && users[0]) setApp(users.find((u) => u.runsAs && !u.runsAs.root)?.appId ?? users[0].appId);
  }, [users, app]);

  const options = [
    ...users.map((u) => ({ value: u.appId, label: u.appName, description: u.runsAs ? (u.runsAs.root ? "Runs as root" : `Runs as ${u.runsAs.user ?? u.runsAs.uid}:${u.runsAs.group ?? u.runsAs.gid} (${u.runsAs.source})`) : "Uses this folder" })),
    ...(allApps ?? []).filter((a) => !users.some((u) => u.appId === a.id)).map((a) => ({ value: a.id, label: a.name, description: "Doesn't mount this folder" })),
  ];

  async function check() {
    if (!path || !app) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase({ kind: "checking", done: 0, toChange: 0 });
    try {
      await streamPost<{ type: string; done?: number; toChange?: number; message?: string; preview?: OwnershipPreview }>(
        "/api/files/ownership/preview",
        { path, app },
        (e) => {
          if (e.type === "progress") setPhase({ kind: "checking", done: e.done ?? 0, toChange: e.toChange ?? 0 });
          if (e.type === "done" && e.preview) setPhase({ kind: "ready", preview: e.preview });
          if (e.type === "error") setPhase({ kind: "error", message: e.message ?? "Checking failed." });
        },
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) setPhase({ kind: "error", message: e instanceof Error ? e.message : "Checking failed." });
    }
  }

  async function apply() {
    if (!path || phase.kind !== "ready") return;
    setBusy(true);
    try {
      const r = await api.post<{ job: FileJob }>("/api/files/ownership", { path, app });
      onStarted(r.job);
      toast.info(r.job.title, { description: "Running in the background. You can undo it from the tasks tray when it's done." });
      onClose();
    } catch (e) {
      toast.error("Couldn't change the owners", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    abort.current?.abort();
    onClose();
  };
  const p = phase.kind === "ready" ? phase.preview : null;
  const who = p ? `${p.app?.name ?? ""}`.trim() || `${p.target.user ?? p.target.uid}` : "";

  return (
    <Dialog
      open={!!path}
      onOpenChange={(o) => !o && close()}
      title="Fix ownership for an app"
      description={
        <>
          Give everything in <span className="mono">{path}</span> to the user an app runs as, so it can read and write the files. Other drives mounted inside aren't touched.
        </>
      }
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {p && p.toChange > 0 ? (
            <Button variant="primary" loading={busy} onClick={() => void apply()}>
              Give {fmt.plural(p.toChange, "item")} to {who}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void check()} disabled={!app || phase.kind === "checking"} loading={phase.kind === "checking"}>
              Check files
            </Button>
          )}
        </>
      }
    >
      <div className={s.stack}>
        <Field label="App">
          {options.length ? (
            <Select
              aria-label="App"
              value={app}
              onChange={(v) => {
                setApp(v);
                setPhase({ kind: "choose" });
              }}
              options={options}
              placeholder="Choose an app"
            />
          ) : (
            <Skeleton height={34} />
          )}
        </Field>
        {phase.kind === "checking" && (
          <p className="muted num" role="status">
            Checked {phase.done.toLocaleString()} items{phase.toChange ? `, ${phase.toChange.toLocaleString()} need a new owner` : ""}…
          </p>
        )}
        {phase.kind === "error" && (
          <Notice tone="fault" title="Can't check this folder">
            {phase.message}
          </Notice>
        )}
        {p && (
          <>
            <Notice tone={p.toChange ? "attention" : "neutral"} title={p.toChange ? `${fmt.plural(p.toChange, "item")} will change` : "Nothing to change"}>
              {p.summary}
              {p.partial && " Counting stopped early because the folder is very large, so the real number may be higher."}
            </Notice>
            {p.byOwner.length > 0 && (
              <div>
                <h3 className={s.subTitle}>Currently owned by</h3>
                <ul className={s.ownerList}>
                  {p.byOwner.slice(0, 6).map((o) => (
                    <li key={`${o.uid}:${o.gid}`}>
                      <span className="mono">
                        {o.user ?? o.uid}:{o.group ?? o.gid}
                      </span>
                      <span className="num muted">{fmt.plural(o.count, "item")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.samples.length > 0 && (
              <Disclosure summary="Examples" meta={p.samples.length > 12 ? `12 of ${p.samples.length}` : String(p.samples.length)}>
                <ul className={s.sampleList}>
                  {p.samples.slice(0, 12).map((x) => (
                    <li key={x.path} className="mono truncate" title={x.path}>
                      {x.path}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
