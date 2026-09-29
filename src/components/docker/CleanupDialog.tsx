"use client";
import * as React from "react";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import type { CleanupKind, CleanupPlan, CleanupResult } from "@/lib/docker-types";
import { LoadError, isReauthCancel } from "./shared";
import s from "./docker.module.css";

const COPY: Record<CleanupKind, { title: string; lead: string; noun: [string, string]; verb: string; empty: string }> = {
  images: {
    title: "Remove unused images",
    lead: "No container uses these. Apps download their image again when they need it; the ones that can't be downloaded again are marked and left unticked.",
    noun: ["image", "images"],
    verb: "Remove",
    empty: "Every image is in use by a container. Nothing to remove.",
  },
  containers: {
    title: "Remove stopped containers",
    lead: "Removing a container deletes its own changes to its files (not its volumes or folders). Containers that belong to an app are left unticked: the app's installer recreates them when it starts.",
    noun: ["stopped container", "stopped containers"],
    verb: "Remove",
    empty: "Every container is running. Nothing to remove.",
  },
  volumes: {
    title: "Remove unused volumes",
    lead: "No container uses these. What's inside is deleted for good. Unnamed volumes are usually scratch space; named ones may hold an app's data, so they start unticked.",
    noun: ["volume", "volumes"],
    verb: "Delete",
    empty: "Every volume is used by a container. Nothing to remove.",
  },
  buildcache: {
    title: "Clear the build cache",
    lead: "Docker keeps steps of earlier image builds to make the next build faster. Clearing it frees the space; the next build of a local image (Gluon's own updates, for one) starts from scratch and takes longer.",
    noun: ["cache entry", "cache entries"],
    verb: "Clear",
    empty: "The build cache has nothing it can let go of.",
  },
};

/**
 * The preview for every Docker cleanup: exactly what would go, what it frees, what is kept and
 * why. The person ticks what goes; the server checks each item again before removing it.
 */
export function CleanupDialog({ kind, open, onClose, onDone }: { kind: CleanupKind; open: boolean; onClose: () => void; onDone?: (r: CleanupResult) => void }) {
  const fmt = useFormat();
  const { data: plan, error, isLoading, isValidating, mutate } = useApi<CleanupPlan>(open ? `/api/docker/cleanup?kind=${kind}` : null, { revalidateOnFocus: false, keepPreviousData: false, dedupingInterval: 0 });
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CleanupResult | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const copy = COPY[kind];

  React.useEffect(() => {
    if (open) {
      setResult(null);
      setFailure(null);
    }
  }, [open]);
  React.useEffect(() => {
    if (plan) setPicked(new Set(plan.items.filter((i) => i.preselect).map((i) => i.id)));
  }, [plan]);

  const items = plan?.items ?? [];
  const chosen = items.filter((i) => picked.has(i.id));
  const bytes = kind === "buildcache" ? (plan?.bytes ?? 0) : chosen.reduce((a, i) => a + (i.bytes ?? 0), 0);
  const unknownBytes = chosen.some((i) => i.bytes === null);
  const n = chosen.length;
  const bytesText = bytes > 0 ? (kind === "images" ? `at least ${fmt.bytes(bytes)}` : `${unknownBytes ? "at least " : kind === "buildcache" ? "about " : ""}${fmt.bytes(bytes)}`) : null;
  const canGo = kind === "buildcache" ? (plan?.bytes ?? 0) > 0 : n > 0;

  async function go() {
    setBusy(true);
    setFailure(null);
    try {
      const r = await api.post<CleanupResult>("/api/docker/cleanup", { kind, ids: chosen.map((i) => i.id) });
      setResult(r);
      onDone?.(r);
      if (!r.skipped.length) {
        toast.success(r.message);
        onClose();
      }
    } catch (e) {
      if (!isReauthCancel(e)) setFailure(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const allOn = items.length > 0 && n === items.length;
  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button variant="dangerSolid" disabled={!plan || !canGo} loading={busy} onClick={() => void go()}>
        {kind === "buildcache" ? "Clear the build cache" : n ? `${copy.verb} ${fmt.plural(n, copy.noun[0], copy.noun[1])}` : `${copy.verb} ${copy.noun[1]}`}
      </Button>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()} title={copy.title} description={result ? undefined : copy.lead} size="wide" footer={footer} footerStart={!result && plan && bytesText ? <span className="num">Frees {bytesText}</span> : undefined}>
      {result ? (
        <div className={s.result} role="status">
          <p className={s.resultLine}>{result.message}</p>
          {result.skipped.length > 0 && (
            <>
              <p className={s.planNote}>Left alone:</p>
              <ul className={s.skipList}>
                {result.skipped.map((k, i) => (
                  <li key={i}>
                    <span className="mono">{k.label}</span>: {k.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : error ? (
        <LoadError error={error} what="the preview" onRetry={() => void mutate()} retrying={isValidating} />
      ) : !plan || isLoading ? (
        <div className={s.planSkeleton} aria-busy="true" aria-label="Working out what can go">
          {Array.from({ length: kind === "buildcache" ? 1 : 4 }, (_, i) => (
            <div key={i}>
              <Skeleton width={17} height={17} radius={4} />
              <Skeleton width={`${45 + i * 11}%`} height={12} />
              <Skeleton width={50} height={12} />
            </div>
          ))}
          {kind === "images" && <p className={s.planNote} style={{ padding: "10px 12px", background: "var(--panel)" }}>Asking the registries which images can be downloaded again…</p>}
        </div>
      ) : kind === "buildcache" ? (
        <p className={s.resultLine}>{plan.bytes > 0 ? <>About <b className="num">{fmt.bytes(plan.bytes)}</b> of cache isn&apos;t used by any image.</> : copy.empty}</p>
      ) : items.length === 0 ? (
        <>
          <p className={s.resultLine}>{copy.empty}</p>
          <Kept plan={plan} />
        </>
      ) : (
        <>
          <div className={s.planHead}>
            <span>
              <b className="num">{fmt.plural(items.length, copy.noun[0], copy.noun[1])}</b> can go{picked.size !== items.length ? <span className="num">, {n} ticked</span> : null}.
            </span>
            <span className={s.planTools}>
              <Button size="sm" variant="ghost" onClick={() => setPicked(allOn ? new Set() : new Set(items.map((i) => i.id)))}>
                {allOn ? "Untick all" : "Tick all"}
              </Button>
            </span>
          </div>
          <ul className={s.planList}>
            {items.map((i) => (
              <li key={i.id}>
                <label className={s.planItem}>
                  <Checkbox
                    checked={picked.has(i.id)}
                    onChange={(c) =>
                      setPicked((cur) => {
                        const next = new Set(cur);
                        if (c) next.add(i.id);
                        else next.delete(i.id);
                        return next;
                      })
                    }
                  />
                  <span className={s.planText}>
                    <span className={/\s/.test(i.label) ? s.planLabelText : s.planLabel} title={i.label}>
                      {i.label}
                    </span>
                    {(i.detail || i.note) && (
                      <span className={s.planNote}>
                        {i.detail && (
                          <span className={s.planDetail} title={i.detail}>
                            {i.detail}
                          </span>
                        )}
                        {i.detail && i.note ? " · " : ""}
                        {i.note}
                      </span>
                    )}
                    {i.caution && <span className={s.planCaution}>{i.caution}</span>}
                  </span>
                  <span className={s.planBytes}>{i.bytes === null ? "–" : fmt.bytes(i.bytes)}</span>
                </label>
              </li>
            ))}
          </ul>
          <Kept plan={plan} />
        </>
      )}
      {failure && (
        <div className={s.detailNote}>
          <Notice tone="fault" title="Nothing was removed">
            {failure}
          </Notice>
        </div>
      )}
    </Dialog>
  );
}

function Kept({ plan }: { plan: CleanupPlan }) {
  if (!plan.kept.length) return null;
  return (
    <div className={s.planKept}>
      Always kept:
      <ul>
        {plan.kept.map((k, i) => (
          <li key={i}>
            <span className="mono">{k.label}</span>: {k.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
