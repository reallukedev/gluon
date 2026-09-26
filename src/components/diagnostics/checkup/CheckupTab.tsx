"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { CheckupKind, CheckupRun, CheckupState, CheckState } from "@/lib/diagnostics-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { Mark, ProbePath, Sweep, type TickState } from "./Instruments";
import { ResultList, resultDomId } from "./Results";
import { History, Symptoms } from "./Launcher";
import { dismissError, startCheckup, stopCheckup, toView, useCheckupRun, STATE_URL, type RunView } from "./useCheckupRun";
import { RemedyButton } from "@/components/status/NeedsYou";
import s from "./checkup.module.css";

const REST_ROWS = ["Internet", "Public addresses", "Apps", "Storage", "Hardware", "System", "Security"];

export interface CheckupStart {
  kind: CheckupKind;
  target: string | null;
}

/** The Checkup tab: run a full checkup or a targeted one, watch it live, and look back at past runs. */
export function CheckupTab({ initial, runId, start }: { initial: CheckupState | null; runId: string | null; start: CheckupStart | null }) {
  const router = useRouter();
  const state = useApi<CheckupState>(STATE_URL, { fallbackData: initial ?? undefined, refresh: 30_000 });
  const live = useCheckupRun();
  const wantsStored = !!runId && live.view?.meta.id !== runId;
  const stored = useApi<CheckupRun>(wantsStored ? `${STATE_URL}/${encodeURIComponent(runId!)}` : null, { revalidateOnFocus: false });
  const top = React.useRef<HTMLDivElement>(null);

  // ⌘K links arrive as ?start=…: run once, then drop the parameter so a reload doesn't run it again.
  const autoStarted = React.useRef(false);
  React.useEffect(() => {
    if (!start || autoStarted.current) return;
    autoStarted.current = true;
    router.replace("/diagnostics", { scroll: false });
    void startCheckup(start.kind, start.target);
  }, [start, router]);

  const run = React.useCallback(
    (kind: CheckupKind, target: string | null) => {
      if (runId) router.replace("/diagnostics", { scroll: false });
      void startCheckup(kind, target);
      top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [runId, router],
  );

  const view: RunView | null = runId ? (live.view?.meta.id === runId ? live.view : stored.data ? toView(stored.data) : null) : (live.view ?? (state.data?.latest ? toView(state.data.latest) : null));
  const others = (state.data?.active ?? []).filter((a) => a.id !== live.view?.meta.id);
  const loadingStored = wantsStored && !stored.data && !stored.error;

  return (
    <div className={s.stack} ref={top} style={{ scrollMarginTop: 96 }}>
      {live.error && (
        <Notice tone="fault" title="The checkup couldn't run" action={<Button size="sm" variant="ghost" onClick={dismissError}>Dismiss</Button>}>
          {live.error}
        </Notice>
      )}
      {!live.streaming && others.length > 0 && (
        <Notice
          tone="neutral"
          title={`${others[0]!.startedBy ?? "Someone"} is running a checkup: ${others[0]!.title}`}
          action={
            <Button size="sm" onClick={() => run(others[0]!.kind, others[0]!.target)}>
              Watch it
            </Button>
          }
        >
          Started <Time ts={others[0]!.startedAt} />. Watching it shows the results as they come in.
        </Notice>
      )}
      {stored.error && runId && (
        <Notice tone="fault" title="That checkup isn't available" action={<Button size="sm" onClick={() => router.replace("/diagnostics", { scroll: false })}>Show the latest</Button>}>
          {stored.error.message} Gluon keeps the last 50 checkups.
        </Notice>
      )}

      {live.pending && !live.view ? (
        <Starting kind={live.pending.kind} onStop={() => void stopCheckup()} />
      ) : loadingStored || (!state.data && !view) ? (
        <div className={s.run}>
          <div className={s.runHead}>
            <Skeleton width={180} height={16} />
          </div>
          <div style={{ padding: 18, display: "grid", gap: 12 }}>
            <Skeleton width="55%" height={24} />
            <Skeleton height={170} />
          </div>
        </div>
      ) : view ? (
        <RunPanel key={view.meta.id} view={view} streaming={live.streaming && live.view?.meta.id === view.meta.id} isLive={live.view?.meta.id === view.meta.id} onRun={run} onBackToLatest={runId ? () => router.replace("/diagnostics", { scroll: false }) : null} />
      ) : (
        <AtRest busy={live.streaming} onRun={() => run("full", null)} />
      )}

      <div className={s.cols}>
        <Symptoms targets={state.data?.targets ?? null} busy={live.streaming} onRun={run} />
        <History runs={state.data?.recent ?? []} current={view?.meta.id ?? null} hrefFor={(id) => `/diagnostics?run=${encodeURIComponent(id)}`} />
      </div>
    </div>
  );
}

function AtRest({ busy, onRun }: { busy: boolean; onRun: () => void }) {
  return (
    <section className={s.run} aria-labelledby="checkup-rest">
      <div className={s.rest}>
        <div className={s.restRows} aria-hidden>
          {REST_ROWS.map((r) => (
            <div key={r} className={s.restRow}>
              <span className={s.sweepLabel}>{r}</span>
              <span className={s.restRail} />
            </div>
          ))}
        </div>
        <div className={s.restText}>
          <h3 id="checkup-rest">Check the whole server</h3>
          <p>A full checkup looks at the internet connection, your public addresses, every app, the drives, the hardware, the system and its security. It takes about a minute and changes nothing.</p>
          <Button variant="primary" onClick={onRun} disabled={busy}>
            Run a full checkup
          </Button>
        </div>
      </div>
    </section>
  );
}

const KIND_TITLE: Record<CheckupKind, string> = {
  full: "Full checkup",
  app: "Checking the app",
  address: "Checking the address",
  internet: "Checking the internet connection",
  server: "Checking why the server is slow",
  space: "Checking space",
  drive: "Checking the drive",
  safety: "Checking how safe the server is",
};

function Starting({ kind, onStop }: { kind: CheckupKind; onStop: () => void }) {
  return (
    <section className={s.run} aria-busy="true" aria-label={KIND_TITLE[kind]}>
      <div className={s.runHead}>
        <div className={s.runTitle}>
          <h2>{KIND_TITLE[kind]}</h2>
        </div>
        <div className={s.runActions}>
          <Button size="sm" onClick={onStop}>
            Stop
          </Button>
        </div>
      </div>
      <div className={s.starting} role="status">
        <Mark state="running" />
        Working out what to check…
      </div>
    </section>
  );
}

function verdictState(v: RunView, streaming: boolean): TickState {
  if (streaming) return "running";
  if (!v.summary || v.summary.status !== "done") return "skip";
  const c = v.summary.counts;
  return c.fail ? "fail" : c.warn ? "warn" : "ok";
}

function RunPanel({ view, streaming, isLive, onRun, onBackToLatest }: { view: RunView; streaming: boolean; isLive: boolean; onRun: (kind: CheckupKind, target: string | null) => void; onBackToLatest: (() => void) | null }) {
  const fmt = useFormat();
  const results = React.useMemo(() => new Map(view.results.map((r) => [r.id, r])), [view.results]);
  const running = React.useMemo(() => new Set(view.running), [view.running]);
  const [openPassed, setOpenPassed] = React.useState(false);
  const [flash, setFlash] = React.useState<string | null>(null);
  const { meta, plan, summary } = view;
  const done = view.results.length;
  const total = plan.length;
  const counts = view.results.reduce((a, r) => ((a[r.state] += 1), a), { ok: 0, warn: 0, fail: 0, skip: 0 } as Record<CheckState, number>);
  const vState = verdictState(view, streaming);

  const open = React.useCallback(
    (id: string) => {
      const r = results.get(id);
      if (!r) return;
      if (r.state === "ok" || r.state === "skip") setOpenPassed(true);
      setFlash(id);
      requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(resultDomId(id))?.scrollIntoView({ block: "center", behavior: "smooth" })));
    },
    [results],
  );
  React.useEffect(() => {
    if (!flash) return;
    const el = document.getElementById(resultDomId(flash));
    el?.setAttribute("data-flash", "");
    const t = setTimeout(() => {
      el?.removeAttribute("data-flash");
      setFlash(null);
    }, 1300);
    return () => clearTimeout(t);
  }, [flash]);

  const hops = plan.filter((p) => p.hop);
  const breakHop = meta.layout === "path" ? (hops.find((h) => results.get(h.id)?.state === "fail") ?? hops.find((h) => results.get(h.id)?.state === "warn")) : undefined;
  const breakResult = breakHop ? results.get(breakHop.id)! : null;

  let verdict: React.ReactNode;
  if (streaming) {
    verdict = (
      <span className={s.progress}>
        Checking… {done} of {total}
      </span>
    );
  } else verdict = summary?.verdict ?? "This checkup didn't finish.";

  const sub: React.ReactNode[] = [];
  if (streaming) {
    if (counts.fail || counts.warn) sub.push(`${counts.fail ? `${counts.fail} broken` : ""}${counts.fail && counts.warn ? " and " : ""}${counts.warn ? `${counts.warn} to look at` : ""} so far`);
    else if (done) sub.push("Nothing wrong so far");
  } else if (summary) {
    const secs = Math.max(1, Math.round((summary.finishedAt - meta.startedAt) / 1000));
    sub.push(
      <React.Fragment key="when">
        {isLive ? "Finished" : "Checked"} <Time ts={summary.finishedAt} />
      </React.Fragment>,
      `${fmt.plural(total, "check")} in ${fmt.duration(secs)}`,
    );
    if (summary.counts.skip) sub.push(`${summary.counts.skip} skipped`);
  }

  const again = meta.kind === "full" ? "Run it again" : "Check again";
  const problemsCount = counts.fail + counts.warn;
  const diff = summary?.diff;

  return (
    <>
      <section className={s.run} aria-labelledby={`run-${meta.id}`} aria-busy={streaming || undefined}>
        <div className={s.runHead}>
          <div className={s.runTitle}>
            <h2 id={`run-${meta.id}`} title={meta.title}>
              {meta.title}
            </h2>
            <span className={s.runMeta}>
              {streaming ? "Started " : ""}
              <Time ts={meta.startedAt} />
              {meta.startedBy ? ` by ${meta.startedBy}` : ""}
            </span>
          </div>
          <div className={s.runActions}>
            {onBackToLatest && !streaming && (
              <Button size="sm" variant="ghost" onClick={onBackToLatest}>
                Show the latest
              </Button>
            )}
            {streaming ? (
              <Button size="sm" onClick={() => void stopCheckup()}>
                Stop
              </Button>
            ) : (
              <>
                {meta.kind !== "full" && (
                  <Button size="sm" onClick={() => onRun(meta.kind, meta.target)}>
                    {again}
                  </Button>
                )}
                <Button size="sm" variant="primary" onClick={() => onRun("full", null)}>
                  {meta.kind === "full" ? again : "Run a full checkup"}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className={s.verdict} role={streaming ? "status" : undefined}>
          <Mark state={vState} />
          <div>
            <p className={s.verdictText}>{verdict}</p>
            {sub.length > 0 && (
              <p className={s.verdictSub}>
                {sub.map((x, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && " · "}
                    {x}
                  </React.Fragment>
                ))}
              </p>
            )}
          </div>
        </div>

        {diff && (diff.appeared.length > 0 || diff.fixed.length > 0) && (
          <div className={s.diff}>
            {diff.appeared.length > 0 && (
              <div className={s.diffRow}>
                <span className={s.diffLabel}>New since last time</span>
                <ul className={s.diffList} role="list">
                  {diff.appeared.map((d) => (
                    <li key={d.id} data-kind="new">
                      <Mark state={d.state} />
                      <span>{d.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {diff.fixed.length > 0 && (
              <div className={s.diffRow}>
                <span className={s.diffLabel}>Fixed since then</span>
                <ul className={s.diffList} role="list">
                  {diff.fixed.map((d) => (
                    <li key={d.id} data-kind="fixed">
                      <Mark state="ok" />
                      <span>{d.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {diff && !diff.appeared.length && !diff.fixed.length && (
          <p className={s.same}>
            Same results as the previous checkup, <Time ts={diff.previousAt} />.
          </p>
        )}

        {meta.layout === "path" ? (
          <>
            <ProbePath origin={meta.origin} plan={plan} results={results} running={running} live={view.live} onOpen={open} />
            {breakResult && breakResult.detail && (
              <div className={s.break}>
                <Notice
                  tone={breakResult.state === "fail" ? "fault" : "attention"}
                  title={`${breakHop!.label}: ${breakResult.title}`}
                  action={breakResult.fix ? <RemedyButton remedy={{ action: breakResult.fix.action, label: breakResult.fix.label, params: breakResult.fix.params, confirm: breakResult.fix.confirm, href: breakResult.fix.href }} findingId={breakResult.fix.findingId ?? null} /> : undefined}
                >
                  {breakResult.detail}
                </Notice>
              </div>
            )}
            <div style={{ height: 16 }} />
          </>
        ) : (
          <Sweep groups={meta.groups} plan={plan} results={results} running={running} live={view.live} onOpen={open} />
        )}
      </section>

      <Panel
        title={streaming ? "Found so far" : "What it found"}
        meta={problemsCount ? <span className="num">{counts.fail ? `${counts.fail} broken` : ""}{counts.fail && counts.warn ? " · " : ""}{counts.warn ? `${counts.warn} to look at` : ""}</span> : undefined}
        flush
      >
        <ResultList
          plan={plan}
          groups={meta.groups}
          results={view.results}
          showGroups={meta.layout === "sweep" && meta.groups.length > 1}
          openPassed={openPassed}
          setOpenPassed={setOpenPassed}
          emptyNote={
            <p className={s.starting} style={{ padding: "16px 18px" }}>
              <Mark state={streaming ? "running" : done ? "ok" : "skip"} />
              {streaming ? "Nothing wrong so far." : done ? "Nothing to fix. Every check passed." : "No results were recorded."}
            </p>
          }
        />
      </Panel>
    </>
  );
}
