"use client";
import * as React from "react";
import type { SWRResponse } from "swr";
import { Refresh, SystemRestart, ShieldCheck, RefreshDouble, CheckCircle } from "iconoir-react";
import type { PendingPackage, UpdateRun, UpdateRunSummary, UpdatesStatus } from "@/lib/system-types";
import { api, useApi, useStream, streamPost, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Disclosure } from "@/components/ui/Disclosure";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { StreamView, emptyStream, reduceStream, type StreamEvent, type StreamState } from "@/components/ui/StreamLog";
import { InstallDialog, InstallProgress } from "./InstallProgress";
import { updatesOverdue } from "./SystemView";
import s from "./system.module.css";
import u from "./updates.module.css";

const DAY = 86_400_000;
const DOCKER = /^(docker-ce|docker\.io|containerd|containerd\.io|moby-engine)$/;

type ApplyEvent = StreamEvent & { runId?: string; n?: number };

// ---------------------------------------------------------------- following a run over SSE

/** Reattach to a run's live output (after a reload, or when Gluon restarted mid-install). */
function useRunFollow(runId: string | null, onDone: (run: UpdateRunSummary) => void) {
  const [state, setState] = React.useState<StreamState>(emptyStream);
  const last = React.useRef(-1);
  const doneRef = React.useRef(onDone);
  doneRef.current = onDone;
  React.useEffect(() => {
    setState(emptyStream);
    last.current = -1;
  }, [runId]);
  const status = useStream(
    runId ? `/api/system/updates/runs/${encodeURIComponent(runId)}/stream` : null,
    {
      snapshot: (d) => {
        const { run, lines, from } = d as {
          run: UpdateRunSummary;
          lines: string[];
          from: number;
        };
        last.current = from + lines.length - 1;
        setState({
          steps: [
            {
              text: run.kind === "repair" ? "Repairing interrupted updates…" : "Installing updates…",
              state: run.outcome === "running" ? "running" : run.outcome === "ok" ? "done" : "failed",
            },
          ],
          lines: lines.map((text) => ({ text, err: false })),
          result: null,
          progress: null,
        });
      },
      line: (d) => {
        const { n, text } = d as { n: number; text: string };
        if (n <= last.current) return;
        last.current = n;
        setState((st) => reduceStream(st, { type: "line", text }));
      },
      done: (d) => {
        const { run } = d as { run: UpdateRunSummary };
        setState((st) =>
          reduceStream(st, {
            type: "done",
            ok: run.outcome === "ok",
            message: run.summary ?? (run.outcome === "ok" ? "Done." : "The update didn't finish."),
          }),
        );
        doneRef.current(run);
      },
    },
    [runId],
  );
  return { state, status };
}

// ---------------------------------------------------------------- tab

export function UpdatesTab({ status }: { status: SWRResponse<UpdatesStatus, ApiError> }) {
  const fmt = useFormat();
  const { data, error, mutate } = status;
  const runs = useApi<{ runs: UpdateRunSummary[] }>("/api/system/updates/runs?limit=15", { refresh: 60_000 });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [checking, setChecking] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  // Install dialog: POST streams first; if that connection drops (Docker restarting Gluon), follow over SSE.
  const [dialog, setDialog] = React.useState<{
    title: string;
    runId: string | null;
    follow: boolean;
    expected: string[];
  } | null>(null);
  const [postState, setPostState] = React.useState<StreamState>(emptyStream);
  const [running, setRunning] = React.useState(false);
  const refreshAll = React.useCallback(() => {
    void mutate();
    void runs.mutate();
  }, [mutate, runs]);
  const followDialog = useRunFollow(dialog?.follow ? dialog.runId : null, () => {
    setRunning(false);
    refreshAll();
  });

  // A run already in progress when the page loads (or started elsewhere): show it inline.
  const [watchId, setWatchId] = React.useState<string | null>(null);
  const activeId = data?.activeRun?.id ?? null;
  React.useEffect(() => {
    if (activeId && activeId !== dialog?.runId) setWatchId(activeId);
  }, [activeId, dialog?.runId]);
  const [watchDone, setWatchDone] = React.useState(false);
  const inline = useRunFollow(watchId, () => {
    setWatchDone(true);
    refreshAll();
  });

  // Drop selections for packages that are no longer waiting.
  React.useEffect(() => {
    if (!data) return;
    const names = new Set(data.packages.map((p) => p.name));
    setSelected((prev) => {
      const next = new Set([...prev].filter((n) => names.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  async function start(body: { packages?: string[]; repair?: boolean }, title: string, expected: string[] = []) {
    setPostState(emptyStream);
    setDialog({ title, runId: null, follow: false, expected });
    setRunning(true);
    let runId: string | null = null;
    let finished = false;
    try {
      await streamPost<ApplyEvent>("/api/system/updates/apply", body, (e) => {
        if (e.type === "step" && e.runId) {
          runId = e.runId;
          setDialog((d) => (d ? { ...d, runId: e.runId! } : d));
        }
        if (e.type === "done" || e.type === "error") finished = true;
        setPostState((st) => reduceStream(st, e));
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") {
        setDialog(null);
        setRunning(false);
        return;
      }
      if (!runId) {
        finished = true;
        setPostState((st) =>
          reduceStream(st, {
            type: "error",
            message: e instanceof Error ? e.message : "The update couldn't start.",
          }),
        );
      }
    }
    if (!finished && runId) {
      // The stream ended without a result: Gluon probably restarted with Docker. The install keeps going on the host.
      setDialog((d) => (d ? { ...d, follow: true } : d));
      return;
    }
    setRunning(false);
    setSelected(new Set());
    refreshAll();
  }

  async function checkNow() {
    setChecking(true);
    try {
      const r = await api.post<{
        result: { ok: boolean; summary: string };
        status: UpdatesStatus;
      }>("/api/system/updates/refresh");
      void mutate(r.status, { revalidate: false });
      if (r.result.ok) toast.success(r.status.counts.total ? `${fmt.plural(r.status.counts.total, "update")} waiting` : "Everything is up to date");
      else
        toast.error("Couldn't check for updates", {
          description: r.result.summary,
        });
      void runs.mutate();
    } catch (e) {
      toast.error("Couldn't check for updates", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setChecking(false);
    }
  }

  if (!data) {
    if (error) {
      return (
        <Notice tone="fault" title="Couldn't read the list of updates" action={<Button onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      );
    }
    return <UpdatesSkeleton />;
  }

  const installable = data.packages.filter((p) => !p.isNew);
  const blocked = !!data.activeRun || data.busy.length > 0 || data.dpkgInterrupted;
  const chosen = installable.filter((p) => selected.has(p.name));
  const all = data.packages.filter((p) => !p.heldBack);

  function askInstall(pkgs: PendingPackage[], everything: boolean) {
    const n = pkgs.length;
    const consequences: React.ReactNode[] = [`Downloads and installs ${fmt.plural(n, "package")}. It takes a few minutes and apps keep running.`];
    if (pkgs.some((p) => DOCKER.test(p.name))) consequences.push("Docker will restart, so your apps blink off for a few seconds. Gluon restarts too; this page reconnects on its own.");
    const reboot = pkgs.filter((p) => p.needsReboot);
    if (reboot.length)
      consequences.push(`${reboot.length === 1 ? reboot[0]!.name : `${reboot.length} of them`} only take${reboot.length === 1 ? "s" : ""} effect after restarting the server. Gluon will remind you.`);
    if (everything && data!.removals.length) consequences.push(`Also removes ${data!.removals.join(", ")}, which the new versions replace.`);
    consequences.push("It keeps going if you close this page.");
    confirm({
      title: everything ? `Install ${fmt.plural(n, "update")}?` : `Install ${n === 1 ? pkgs[0]!.name : `${n} selected updates`}?`,
      consequences,
      confirmLabel: everything ? "Install all" : "Install",
      variant: "primary",
      onConfirm: () => {
        void start(
          everything ? {} : { packages: pkgs.map((p) => p.name) },
          `Installing ${fmt.plural(n, "update")}`,
          pkgs.map((p) => p.name),
        );
      },
    });
  }

  const security = data.packages.filter((p) => p.security);
  const other = data.packages.filter((p) => !p.security);
  const overdue = updatesOverdue(data);
  const waitingDays = data.oldestPendingAt ? Math.floor((Date.now() - data.oldestPendingAt) / DAY) : 0;

  const dialogState = dialog?.follow ? followDialog.state : postState;
  const reconnecting = dialog?.follow && followDialog.status !== "live" && !dialogState.result;

  return (
    <div className={s.stack}>
      {data.dpkgInterrupted && (
        <Notice
          tone="fault"
          title="A previous update was interrupted"
          action={
            <Button
              onClick={() =>
                confirm({
                  title: "Finish the interrupted update?",
                  consequences: ["Gluon finishes setting up the half-installed packages. It usually takes a minute.", "Apps keep running."],
                  confirmLabel: "Repair",
                  variant: "primary",
                  onConfirm: () => void start({ repair: true }, "Repairing interrupted updates"),
                })
              }
            >
              Repair
            </Button>
          }
        >
          Some packages are half-installed, so nothing else can be installed until they're finished.
        </Notice>
      )}
      {data.busy.length > 0 && !data.activeRun && (
        <Notice tone="attention" title="Another program is installing software">
          <span className="mono">{[...new Set(data.busy.map((b) => b.command.split(" ")[0]))].join(", ")}</span> is using the package manager. Installing here waits until it finishes.
        </Notice>
      )}
      {data.lastRefresh.ok === false && (
        <Notice
          tone="fault"
          title="Couldn't check for updates"
          action={
            <Button loading={checking} onClick={() => void checkNow()}>
              Try again
            </Button>
          }
        >
          {data.lastRefresh.error ?? "apt couldn't refresh the package lists."} The list below may be out of date.
        </Notice>
      )}

      {watchId && (!dialog || dialog.runId !== watchId) && (
        <Panel
          title={watchDone ? "Update finished" : "Installing updates"}
          meta={
            watchDone ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setWatchId(null);
                  setWatchDone(false);
                }}
              >
                Dismiss
              </Button>
            ) : (
              <span>{inline.status === "live" ? "Live" : "Reconnecting…"}</span>
            )
          }
        >
          <InstallProgress state={inline.state} expected={data.activeRun?.packages ?? []} running={!watchDone} />
        </Panel>
      )}

      <Panel
        title="Updates"
        meta={
          data.lastRefresh.at ? (
            <span>
              Last checked <Time ts={data.lastRefresh.at} />
            </span>
          ) : (
            <span>Not checked yet</span>
          )
        }
      >
        <div className={s.updHead}>
          <p className={s.updSentence}>
            {data.counts.total === 0 ? (
              "Everything is up to date."
            ) : (
              <>
                <b className="num">{fmt.plural(data.counts.total, "update")}</b>
                {data.counts.security ? <>, {data.counts.security} of them security fixes</> : null}
                {data.oldestPendingAt ? <>, {waitingDays < 1 ? "found today" : `waiting ${fmt.plural(waitingDays, "day")}`}</> : null}.
                {data.counts.needsReboot ? ` ${data.counts.needsReboot === 1 ? "One needs" : `${data.counts.needsReboot} need`} a restart afterwards.` : ""}
              </>
            )}
          </p>
          <div className={s.updActions}>
            <Button icon={<Refresh />} loading={checking} disabled={!!data.activeRun} onClick={() => void checkNow()}>
              Check now
            </Button>
            {all.length > 0 && (
              <Button variant={overdue ? "attention" : "primary"} disabled={blocked} onClick={() => askInstall(all, true)}>
                Install {all.length === 1 ? "update" : `all ${all.length}`}
              </Button>
            )}
          </div>
        </div>
        {data.counts.total > 0 && <Impact pkgs={all.length ? all : data.packages} />}
        {data.counts.total === 0 && (
          <p className={s.updNote}>
            Gluon checks every day
            {data.lastRefresh.lastSuccessAt ? (
              <>
                {" "}
                and last found the lists fresh <Time ts={data.lastRefresh.lastSuccessAt} />
              </>
            ) : null}
            . Security fixes that wait more than three days show up in Needs you.
          </p>
        )}
        {data.removals.length > 0 && <p className={s.updNote}>Installing everything also removes {data.removals.join(", ")}.</p>}
      </Panel>

      {security.length > 0 && <PackageGroup title="Security fixes" pkgs={security} selected={selected} setSelected={setSelected} disabled={blocked} />}
      {other.length > 0 && <PackageGroup title={security.length ? "Other updates" : "Waiting updates"} pkgs={other} selected={selected} setSelected={setSelected} disabled={blocked} />}

      {chosen.length > 0 && (
        <div className={s.selectionBar} role="region" aria-label="Selected updates">
          <span className="num">{fmt.plural(chosen.length, "update")} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="primary" size="sm" disabled={blocked} onClick={() => askInstall(chosen, false)}>
            Install selected
          </Button>
        </div>
      )}

      <History runs={runs.data?.runs} loading={!runs.data && !runs.error} error={runs.error?.message} />

      <InstallDialog
        open={!!dialog}
        expected={dialog?.expected ?? []}
        onClose={() => {
          if (dialog?.runId && watchId === dialog.runId) setWatchId(null);
          setDialog(null);
        }}
        title={dialog?.title ?? "Installing updates"}
        description={
          reconnecting ? "Gluon lost its connection (it may be restarting with Docker). The install keeps going; reconnecting…" : "You can close this page; the install keeps going on the server."
        }
        state={dialogState}
        running={running}
      />
      {confirmNode}
    </div>
  );
}

// ---------------------------------------------------------------- what installing does

/** The consequences of installing, sorted by how much they disturb: the one picture for this tab. */
function Impact({ pkgs }: { pkgs: PendingPackage[] }) {
  const fmt = useFormat();
  const docker = pkgs.filter((p) => DOCKER.test(p.name));
  const reboot = pkgs.filter((p) => p.needsReboot);
  const security = pkgs.filter((p) => p.security);
  const quiet = pkgs.filter((p) => !DOCKER.test(p.name) && !p.needsReboot);
  const names = (list: PendingPackage[]) =>
    list.length <= 3
      ? list.map((p) => p.name).join(", ")
      : `${list
          .slice(0, 2)
          .map((p) => p.name)
          .join(", ")} and ${list.length - 2} more`;
  const rows: {
    key: string;
    icon: React.ReactNode;
    title: React.ReactNode;
    detail: string;
    count: number;
  }[] = [];
  if (security.length)
    rows.push({
      key: "sec",
      icon: <ShieldCheck />,
      count: security.length,
      title: `${fmt.plural(security.length, "security fix", "security fixes")}`,
      detail: `Close known security holes: ${names(security)}. Worth installing soon.`,
    });
  if (docker.length)
    rows.push({
      key: "docker",
      icon: <RefreshDouble />,
      count: docker.length,
      title: "Docker restarts",
      detail: `${names(docker)} ${docker.length === 1 ? "updates" : "update"} the engine that runs your apps, so every app blinks off for about a minute. Gluon reconnects on its own.`,
    });
  if (reboot.length)
    rows.push({
      key: "reboot",
      icon: <SystemRestart />,
      count: reboot.length,
      title: "Needs a server restart afterwards",
      detail: `${names(reboot)} only ${reboot.length === 1 ? "takes" : "take"} effect after a restart. Nothing goes down until you choose to restart.`,
    });
  if (quiet.length)
    rows.push({
      key: "quiet",
      icon: <CheckCircle />,
      count: quiet.length,
      title: docker.length || reboot.length ? `${fmt.plural(quiet.length, "other")} ${quiet.length === 1 ? "is" : "are"} safe` : "Safe to install now",
      detail: "Nothing restarts and apps keep running while they install.",
    });
  return (
    <div className={u.impact} role="list" aria-label="What installing does">
      {rows.map((r) => (
        <div key={r.key} role="listitem" className={u.impactRow} data-kind={r.key}>
          <span className={u.impactIcon} aria-hidden>
            {r.icon}
          </span>
          <span className={u.impactText}>
            <span className={u.impactTitle}>{r.title}</span>
            <span className={u.dim}>{r.detail}</span>
          </span>
          <span className={u.impactTicks} aria-hidden>
            {Array.from({ length: Math.min(r.count, 24) }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- package list

function PackageGroup({
  title,
  pkgs,
  selected,
  setSelected,
  disabled,
}: {
  title: string;
  pkgs: PendingPackage[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  disabled: boolean;
}) {
  const fmt = useFormat();
  const selectable = pkgs.filter((p) => !p.isNew);
  const count = selectable.filter((p) => selected.has(p.name)).length;
  const toggleAll = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of selectable) on ? next.add(p.name) : next.delete(p.name);
      return next;
    });
  return (
    <Panel title={title} meta={<span className="num">{fmt.plural(pkgs.length, "package")}</span>} flush>
      <div className={s.pkgHead}>
        <Checkbox checked={count > 0 && count === selectable.length} indeterminate={count > 0 && count < selectable.length} onChange={toggleAll} disabled={disabled || !selectable.length}>
          Select all
        </Checkbox>
      </div>
      <ul className={s.pkgList}>
        {pkgs.map((p) => (
          <li key={p.name} className={s.pkg}>
            {p.isNew ? (
              <span className={s.pkgCheckSpacer} aria-hidden />
            ) : (
              <Checkbox
                checked={selected.has(p.name)}
                disabled={disabled}
                onChange={(on) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    on ? next.add(p.name) : next.delete(p.name);
                    return next;
                  })
                }
              />
            )}
            <span className={s.pkgMain}>
              <span className={`${s.pkgName} mono`} title={p.name}>
                {p.name}
              </span>
              <span className={`${s.pkgVer} mono`} title={`${p.current ?? "not installed"} → ${p.candidate}`}>
                {p.current ? (
                  <>
                    {p.current} <span aria-label="to">→</span> {p.candidate}
                  </>
                ) : (
                  <>new · {p.candidate}</>
                )}
              </span>
            </span>
            <span className={s.pkgMeta}>
              {p.security && (
                <span className={s.marker} title="Fixes a known security problem">
                  <ShieldCheck aria-hidden /> Security fix
                </span>
              )}
              {DOCKER.test(p.name) && (
                <span className={s.marker} title="Docker restarts while this installs, so apps blink off for a minute">
                  <RefreshDouble aria-hidden /> Restarts Docker
                </span>
              )}
              {p.needsReboot && (
                <span className={s.marker} title="Takes effect after restarting the server">
                  <SystemRestart aria-hidden /> Needs a server restart
                </span>
              )}
              {p.isNew && <span className={s.sub}>Comes with the others</span>}
              {p.heldBack && (
                <span className={s.sub} title="Installing everything leaves this out because it would remove another package. Select it to install it on its own.">
                  Held back
                </span>
              )}
              {!p.isNew && (
                <span className={s.sub}>
                  Found <Time ts={p.firstSeen} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- history

const OUTCOME: Record<UpdateRunSummary["outcome"], { state: LineState; label: string }> = {
  running: { state: "starting", label: "Installing" },
  ok: { state: "running", label: "Finished" },
  failed: { state: "unhealthy", label: "Failed" },
  interrupted: { state: "attention", label: "Interrupted" },
};

function History({ runs, loading, error }: { runs?: UpdateRunSummary[]; loading: boolean; error?: string }) {
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <Panel title="Past updates" flush>
      {loading ? (
        <div className={s.skelRows} style={{ padding: 18 }}>
          <Skeleton height={16} width="70%" />
          <Skeleton height={16} width="55%" />
        </div>
      ) : error ? (
        <p className={s.panelLead}>Couldn't load past updates: {error}</p>
      ) : !runs?.length ? (
        <Empty title="Nothing installed from Gluon yet">Each time you install updates here, the result and the full output are kept for a year.</Empty>
      ) : (
        <ul className={s.runList}>
          {runs.map((r) => (
            <li key={r.id}>
              <div className={s.runRow}>
                <StateLine state={OUTCOME[r.outcome].state} label={OUTCOME[r.outcome].label} />
                <span className={s.runText}>
                  <span className={s.truncate} title={r.summary ?? undefined}>
                    {r.summary ?? (r.kind === "repair" ? "Repair" : "Install updates")}
                  </span>
                  <span className={s.sub}>
                    <Time ts={r.startedAt} kind="dateTime" />
                    {r.username ? ` · ${r.username}` : " · automatic"}
                    {r.packages?.length ? ` · ${r.packages.length <= 3 ? r.packages.join(", ") : `${r.packages.length} chosen packages`}` : ""}
                  </span>
                </span>
              </div>
              <Disclosure summary="Output" variant="panel" open={open === r.id} onOpenChange={(o) => setOpen(o ? r.id : null)}>
                {open === r.id && <RunLog id={r.id} />}
              </Disclosure>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RunLog({ id }: { id: string }) {
  const { data, error } = useApi<UpdateRun>(`/api/system/updates/runs/${encodeURIComponent(id)}`);
  if (error) return <p className={s.panelLead}>Couldn't load the output: {error.message}</p>;
  if (!data)
    return (
      <div className={s.runLog}>
        <Skeleton height={120} radius={8} />
      </div>
    );
  const lines = (data.log || "").split("\n").filter((l, i, arr) => l || i < arr.length - 1);
  return (
    <div className={s.runLog}>
      {lines.length ? (
        <StreamView
          state={{
            ...emptyStream,
            lines: lines.map((text) => ({ text, err: /^(E|W):/.test(text) })),
          }}
          height={320}
        />
      ) : (
        <p className={s.sub}>No output was recorded.</p>
      )}
    </div>
  );
}

function UpdatesSkeleton() {
  return (
    <div className={s.stack} aria-busy>
      <Panel title="Updates">
        <div className={s.skelRows}>
          <Skeleton height={20} width="55%" />
          <Skeleton height={14} width="35%" />
        </div>
      </Panel>
      <Panel title="Waiting updates" flush>
        <div className={s.skelRows} style={{ padding: 18 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={16} width={`${50 + ((i * 17) % 40)}%`} />
          ))}
        </div>
      </Panel>
    </div>
  );
}
