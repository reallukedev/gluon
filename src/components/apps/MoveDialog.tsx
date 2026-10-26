"use client";
import * as React from "react";
import type { MoveEvent, MoveJob, MovePlan } from "@/lib/app-move-types";
import { api, streamPost, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { sourceName } from "@/lib/app-names";
import { Dialog } from "@/components/ui/Dialog";
import { Button, LinkButton } from "@/components/ui/Button";
import { Notice, Skeleton, UsageBar } from "@/components/ui/Surface";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import { StreamView } from "@/components/ui/StreamLog";
import { emptyMove, markSeen, reduceMove, replay, wasSeen, type MoveView } from "./moveStream";
import s from "./move.module.css";

type PlanResponse = { plan: MovePlan | null; job: MoveJob | null; error: { code: string; message: string } | null };
type Phase = "review" | "running" | "done";

const FLOW = [
  { key: "review", label: "Review" },
  { key: "move", label: "Move" },
  { key: "done", label: "Done" },
];

const STAGES = (name: string, from: string) => [
  { key: "stop", label: `Stop the ${from} copy` },
  { key: "copy", label: "Copy its data" },
  { key: "start", label: `Start ${name}` },
  { key: "check", label: "Check it runs" },
];

/**
 * Move an app into Gluon's own apps folder: review exactly what moves and what stays, start it,
 * watch it, and get pointed at the next step. The move runs on the server whatever this dialog does.
 */
export function MoveDialog({
  app,
  open,
  onOpenChange,
  onFinished,
  onRemoveOld,
}: {
  app: { id: string; name: string; source: string };
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onFinished?: (newId: string | null) => void;
  /** Start removing the old copy (it keeps its data unless the person chooses otherwise). */
  onRemoveOld?: () => void;
}) {
  const [phase, setPhase] = React.useState<Phase>("review");
  const [data, setData] = React.useState<PlanResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [view, setView] = React.useState<MoveView>(emptyMove);
  const [starting, setStarting] = React.useState(false);
  /** Why the server refused to start (or follow) a move; stays until the next attempt. */
  const [startError, setStartError] = React.useState<string | null>(null);
  const live = React.useRef(false);
  const finished = React.useRef(onFinished);
  finished.current = onFinished;
  const base = `/api/apps/${encodeURIComponent(app.id)}/move`;
  const from = sourceName(app.source);

  const load = React.useCallback(async (opts: { fresh?: boolean } = {}) => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.get<PlanResponse>(base);
      setData(r);
      if (r.job && !r.job.finishedAt) {
        setView(replay(r.job.events));
        setPhase("running");
      } else if (r.job && !opts.fresh && !wasSeen(r.job)) {
        // A move that ended while nobody watched: show how it went before offering a new one.
        markSeen(r.job);
        setView(replay(r.job.events));
        setPhase("done");
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Gluon couldn't work out the move.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => {
    if (!open || live.current) return;
    setPhase("review");
    setView(emptyMove);
    setData(null);
    setStartError(null);
    void load();
  }, [open, load]);

  // Following a move this page isn't streaming (another tab, a reload, a dropped connection).
  React.useEffect(() => {
    if (!open || phase !== "running" || starting) return;
    let misses = 0;
    let pending = false;
    const t = setInterval(async () => {
      // A slow answer must not stack up polls behind it.
      if (pending) return;
      pending = true;
      const r = await api.get<PlanResponse>(`${base}?only=job`).catch(() => null);
      pending = false;
      if (r && !r.job && ++misses >= 3) {
        // The server has no move for this app: it never started, or Gluon restarted mid-move.
        clearInterval(t);
        setStartError("Gluon has no move running for this app. Check both copies on the Apps page, then review the move again.");
        setPhase("review");
        void load();
        return;
      }
      if (!r?.job) return;
      const v = replay(r.job.events);
      setView(v);
      if (r.job.finishedAt) {
        markSeen(r.job);
        setPhase("done");
        finished.current?.(v.result?.newId ?? null);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [open, phase, base, starting, load]);

  async function start() {
    const plan = data?.plan;
    if (!plan) return;
    setStarting(true);
    setStartError(null);
    live.current = true;
    let acc: MoveView = emptyMove;
    let received = 0;
    try {
      await streamPost<MoveEvent>(base, { planId: plan.id }, (e) => {
        received++;
        acc = reduceMove(acc, e);
        setView(acc);
        setPhase("running");
      });
      if (acc.result) {
        const j = await api.get<PlanResponse>(`${base}?only=job`).then((r) => r.job).catch(() => null);
        if (j) markSeen(j);
        setPhase("done");
        finished.current?.(acc.result.newId);
      } else setPhase("running"); // the stream ended early: follow the move by polling
    } catch (e) {
      if (received > 0) {
        // The stream broke after the move began; the move carries on, so follow it by polling.
        setPhase("running");
      } else if (e instanceof ApiError && e.code === "reauth_cancelled") {
        setPhase("review");
      } else {
        // Refused before it began, or the connection dropped first: only follow a move that exists.
        const job = e instanceof ApiError ? null : await api.get<PlanResponse>(`${base}?only=job`).then((r) => r.job).catch(() => null);
        if (job && !job.finishedAt) {
          setView(replay(job.events));
          setPhase("running");
        } else {
          setStartError(e instanceof Error ? e.message : "Gluon couldn't start the move.");
          setPhase("review");
          if (e instanceof ApiError && (e.code === "conflict" || e.code === "cant_move")) void load();
        }
      }
    } finally {
      live.current = false;
      setStarting(false);
    }
  }

  const plan = data?.plan ?? null;
  const running = phase === "running";
  const result = view.result;
  const blocked = !plan || plan.blockers.length > 0;

  const footer =
    phase === "review" ? (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={blocked || loading} loading={starting} onClick={() => void start()}>
          Move to Gluon
        </Button>
      </>
    ) : running ? (
      <Button variant="ghost" onClick={() => onOpenChange(false)}>
        Hide
      </Button>
    ) : result?.ok && result.newId ? (
      <>
        {onRemoveOld && (
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onRemoveOld();
            }}
          >
            Remove the old copy…
          </Button>
        )}
        <LinkButton href={`/apps/${encodeURIComponent(result.newId)}`} variant="primary" onClick={() => onOpenChange(false)}>
          Open the new {app.name}
        </LinkButton>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button
          onClick={() => {
            setPhase("review");
            setView(emptyMove);
            void load({ fresh: true });
          }}
        >
          Review it again
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={phase === "done" && result?.ok ? `${app.name} runs from Gluon` : `Move ${app.name} to Gluon`}
      description={phase === "review" ? `Gluon copies ${app.name} into its own apps folder and runs it there. The ${from} copy is stopped, not deleted.` : undefined}
      footerStart={phase === "review" ? "Nothing changes until you start the move." : running ? "It keeps going if you close this." : undefined}
      footer={footer}
    >
      {phase === "review" ? (
        <div className={s.flow}>
          <FlowSteps label="Moving to Gluon" steps={FLOW} current="review" />
        </div>
      ) : null}
      {phase === "review" ? (
        loading && !plan ? (
          <ReviewSkeleton />
        ) : loadError || data?.error ? (
          <Notice
            tone="fault"
            title="Gluon can't move it"
            action={
              <Button size="sm" loading={loading} onClick={() => void load()}>
                Check again
              </Button>
            }
          >
            {loadError ?? data?.error?.message}
          </Notice>
        ) : plan ? (
          <>
            {startError && (
              <div className={s.flow}>
                <Notice tone="fault" title="The move didn't start">
                  {startError}
                </Notice>
              </div>
            )}
            <Review plan={plan} from={from} />
          </>
        ) : null
      ) : (
        <div className={s.run}>
          <FlowSteps label="Steps" steps={STAGES(app.name, from)} current={view.stage ?? "stop"} working={running} failed={phase === "done" && !result?.ok} complete={phase === "done" && !!result?.ok} />
          {phase === "done" && result && (
            <Notice tone={result.ok ? "neutral" : "fault"} title={result.ok ? "Moved" : result.rolledBack ? "The move didn't work, so nothing changed" : "The move stopped"}>
              {result.message}
            </Notice>
          )}
          {phase === "done" ? (
            <Disclosure summary="What Gluon did" meta={`${view.stream.lines.length} lines`}>
              <StreamView state={{ ...view.stream, result: null }} height={240} />
            </Disclosure>
          ) : (
            <StreamView state={{ ...view.stream, result: null }} height={260} />
          )}
        </div>
      )}
    </Dialog>
  );
}

function ReviewSkeleton() {
  return (
    <div className={s.review} aria-busy="true" aria-label="Working out the move">
      <Skeleton height={15} width="82%" />
      <Skeleton height={6} radius={3} />
      <div className={s.list}>
        {[68, 54, 72].map((w, i) => (
          <div key={i} className={s.skelRow}>
            <Skeleton height={12} width={`${w}%`} />
            <Skeleton height={10} width={`${w - 24}%`} />
          </div>
        ))}
      </div>
      <p className={s.hint}>Measuring its folders. Big libraries take a moment.</p>
    </div>
  );
}

function Review({ plan, from }: { plan: MovePlan; from: string }) {
  const fmt = useFormat();
  const present = plan.copies.filter((c) => !c.missing);
  const ports = [...new Set(plan.ports.map((p) => (p.proto === "udp" ? `${p.host}/udp` : String(p.host))))];
  const rel = (to: string) => (to.startsWith(`${plan.folder}/`) ? `./${to.slice(plan.folder.length + 1)}` : to);
  const usedPct = plan.space.free ? Math.min(100, (plan.space.needed / plan.space.free) * 100) : 100;

  return (
    <div className={s.review}>
      <p className={s.verdict}>
        {plan.blockers.length ? (
          <>
            <b>It can't move yet.</b> {plan.blockers.length === 1 ? "One thing needs fixing first." : `${plan.blockers.length} things need fixing first.`}
          </>
        ) : (
          <>
            Gluon stops {plan.name} from {from}, copies <b className="num">{fmt.bytes(plan.space.needed)}</b> into <span className="mono">{plan.folder}</span>
            {ports.length ? (
              <>
                , and starts the copy on {ports.length === 1 ? "port" : "ports"} <span className="mono">{ports.join(", ")}</span>
              </>
            ) : (
              ", and starts the copy"
            )}
            .
          </>
        )}
      </p>

      {plan.blockers.length > 0 && (
        <Notice tone="fault" title={plan.blockers.length === 1 ? "Before it can move" : "Before it can move, fix these"}>
          <ul className={s.bullets}>
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className={s.space}>
        <div className={s.spaceHead}>
          <span className="label">Space</span>
          <span className="num">
            {plan.space.free === null ? `Needs ${fmt.bytes(plan.space.needed)}; free space unknown` : `${fmt.bytes(plan.space.needed)} of ${fmt.bytes(plan.space.free)} free`}
          </span>
        </div>
        <UsageBar value={usedPct} attention={85} fault={95} label={`The copy uses ${Math.round(usedPct)}% of the free space`} />
      </div>

      <section className={s.group} aria-labelledby="move-copies">
        <h3 id="move-copies" className={s.groupTitle}>
          Copied into the new folder <span className="num">{present.length}</span>
        </h3>
        {plan.copies.length === 0 ? (
          <p className={s.none}>Nothing to copy. Everything it uses stays where it is.</p>
        ) : (
          <ul className={s.list}>
            {plan.copies.map((c) => (
              <li key={c.from} className={s.transfer} data-missing={c.missing ? "" : undefined}>
                <span className={`${s.path} mono`} title={c.from}>
                  {c.kind === "volume" && c.volume && !/^[0-9a-f]{64}$/.test(c.volume) ? `volume ${c.volume}` : c.from}
                </span>
                <span className={s.wire} aria-hidden />
                <span className={`${s.path} ${s.to} mono`} title={c.to}>
                  {rel(c.to)}
                </span>
                <span className={`${s.size} num`}>{c.missing ? "Not made yet" : c.size === null ? "Not measured" : fmt.bytes(c.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(plan.stays.length > 0 || plan.sharedVolumes.length > 0) && (
        <section className={s.group} aria-labelledby="move-stays">
          <h3 id="move-stays" className={s.groupTitle}>
            Used where it is <span className="num">{plan.stays.length + plan.sharedVolumes.length}</span>
          </h3>
          <p className={s.hint}>The copy reads these in place. Gluon never copies or deletes them.</p>
          <ul className={s.list}>
            {plan.stays.map((p) => (
              <li key={p.path} className={s.stay}>
                <span className={`${s.path} mono`} title={p.path}>
                  {p.path}
                </span>
                <span className={s.note}>{p.readOnly ? "Read-only" : ""}</span>
              </li>
            ))}
            {plan.sharedVolumes.map((v) => (
              <li key={v} className={s.stay}>
                <span className={`${s.path} mono`}>volume {v}</span>
                <span className={s.note}>Shared</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <dl className={s.facts}>
        <dt>Stops</dt>
        <dd>
          {plan.stops.name} from {from}, {plan.stops.containers.length === 1 ? "1 container" : `${plan.stops.containers.length} containers`}. Its data stays as it is.
        </dd>
        <dt>New app</dt>
        <dd>
          <span className="mono">{plan.newId}</span>
        </dd>
      </dl>

      {plan.warnings.length > 0 && (
        <Notice tone="attention" title={plan.warnings.length === 1 ? "Worth knowing" : `${plan.warnings.length} things worth knowing`}>
          <ul className={s.bullets}>
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Disclosure summary="The new compose file" meta={`${plan.compose.split("\n").length} lines`}>
        <pre className={`${s.code} mono`}>{plan.compose}</pre>
      </Disclosure>
    </div>
  );
}
