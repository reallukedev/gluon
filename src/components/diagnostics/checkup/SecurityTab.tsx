"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SECURITY_GROUPS, type CheckupKind, type SecurityState } from "@/lib/diagnostics-types";
import { useApi } from "@/lib/client/api";
import { Button, buttonClass } from "@/components/ui/Button";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { AtRest, RunPanel, Starting } from "./CheckupTab";
import { History } from "./Launcher";
import { dismissError, startCheckup, stopCheckup, toView, useCheckupRun, SECURITY_URL } from "./useCheckupRun";
import s from "./checkup.module.css";

const ROWS = SECURITY_GROUPS.map((g) => g.label);

/**
 * The Security tab: the security checkup on its own page. Shows the run in progress or the last one,
 * with the area rows as the instrument, and earlier runs to compare against.
 */
export function SecurityTab({ initial, autostart }: { initial: SecurityState | null; autostart: boolean }) {
  const router = useRouter();
  const state = useApi<SecurityState>(SECURITY_URL, { fallbackData: initial ?? undefined, refresh: 30_000 });
  const live = useCheckupRun();
  const top = React.useRef<HTMLDivElement>(null);

  const run = React.useCallback((kind: CheckupKind, target: string | null) => {
    void startCheckup(kind, target);
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  const start = React.useCallback(() => run("safety", null), [run]);

  // ⌘K arrives as ?start=safety: run once, then drop it so a reload doesn't run it again.
  const autoStarted = React.useRef(false);
  React.useEffect(() => {
    if (!autostart || autoStarted.current) return;
    autoStarted.current = true;
    router.replace("/diagnostics?tab=security", { scroll: false });
    void startCheckup("safety", null);
  }, [autostart, router]);

  const liveSecurity = live.view?.meta.kind === "safety" ? live.view : null;
  const view = liveSecurity ?? (state.data?.latest ? toView(state.data.latest) : null);
  const pendingSecurity = live.pending?.kind === "safety" && !live.view;
  // Another kind of checkup streaming in this tab: starting one here would stop it.
  const otherHere = live.streaming && !liveSecurity && !pendingSecurity ? (live.view?.meta.title ?? "A checkup") : null;
  const others = (state.data?.active ?? []).filter((a) => a.id !== live.view?.meta.id);

  return (
    <div className={s.stack} ref={top} style={{ scrollMarginTop: 96 }}>
      {live.error && (
        <Notice tone="fault" title="The checkup couldn't run" action={<Button size="sm" variant="ghost" onClick={dismissError}>Dismiss</Button>}>
          {live.error}
        </Notice>
      )}
      {otherHere && (
        <Notice tone="neutral" title={`${otherHere} is running`} action={<Link href="/diagnostics" className={buttonClass({ size: "sm" })}>Watch it</Link>}>
          Starting a security checkup stops it.
        </Notice>
      )}
      {!live.streaming && others.length > 0 && (
        <Notice tone="neutral" title={`${others[0]!.startedBy ?? "Someone"} is running a security checkup`} action={<Button size="sm" onClick={start}>Watch it</Button>}>
          Started <Time ts={others[0]!.startedAt} />.
        </Notice>
      )}

      {pendingSecurity ? (
        <Starting kind="safety" onStop={() => void stopCheckup()} />
      ) : !state.data && !view ? (
        <div className={s.run}>
          <div className={s.runHead}>
            <Skeleton width={180} height={16} />
          </div>
          <div style={{ padding: 18, display: "grid", gap: 12 }}>
            <Skeleton width="55%" height={24} />
            <Skeleton height={190} />
          </div>
        </div>
      ) : view ? (
        <RunPanel key={view.meta.id} view={view} home="safety" streaming={!!liveSecurity && live.streaming} isLive={!!liveSecurity} onRun={run} onBackToLatest={null} />
      ) : (
        <AtRest rows={ROWS} title="Check the server's security" cta="Run a security checkup" busy={live.streaming} onRun={start} />
      )}

      {(state.data?.recent.length ?? 0) > 1 && <History title="Earlier security checkups" runs={state.data!.recent} current={view?.meta.id ?? null} hrefFor={(id) => `/diagnostics?run=${encodeURIComponent(id)}`} />}
    </div>
  );
}
