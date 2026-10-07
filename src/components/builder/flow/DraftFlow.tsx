"use client";
import * as React from "react";
import { api, useApi } from "@/lib/client/api";
import type { BuilderTarget, CustomAppDetail, Issue, ServerCheck, StoreStatus } from "@/lib/builder-types";
import { Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { analyze, applyFix, detailIssues } from "@/lib/builder/analyze";
import { toast } from "@/components/ui/Toast";
import { useDraft } from "../state";
import { useJob } from "../useJob";
import { StoreSetupDialog } from "../StoreSetup";
import { SetupStep } from "./SetupStep";
import { AddressStep } from "./AddressStep";
import { ReviewStep } from "./ReviewStep";
import { StartStep } from "./StartStep";
import { useAddressChoice } from "./address";
import { FlowFrame, type FlowStepKey } from "./FlowFrame";
import f from "./flow.module.css";

export type DraftStep = Exclude<FlowStepKey, "source">;

const STEP_NAMES: Record<DraftStep, string> = { setup: "Set up", address: "Public address", review: "Review", start: "Start" };

/**
 * The guided steps after the draft exists. Everything typed autosaves into the draft (the same
 * one the full builder edits), and the step lives in the address bar, so a reload lands where
 * the person was.
 */
export function DraftFlow({ initial, initialStep, target: platformTarget }: { initial: CustomAppDetail; initialStep: DraftStep; target: BuilderTarget }) {
  const [step, setStepState] = React.useState<DraftStep>(() => (initial.job && !initial.job.finishedAt) || initial.status === "published" ? "start" : initialStep);
  // Poll while a job runs (SWR re-reads the option each render, so it follows the latest detail).
  const [jobActive, setJobActive] = React.useState(!!initial.job && !initial.job.finishedAt);
  const { data, mutate } = useApi<CustomAppDetail>(`/api/custom-apps/${initial.id}`, { fallbackData: initial, refresh: jobActive ? 1500 : undefined, revalidateOnFocus: false });
  const d = data ?? initial;
  const active = !!d.job && !d.job.finishedAt;
  if (active !== jobActive) setJobActive(active);
  const target: BuilderTarget = d.target ?? platformTarget;
  const draft = useDraft(d, (patch) => void mutate({ ...d, ...patch }, { revalidate: false }));
  const { data: store, mutate: mutateStore } = useApi<StoreStatus>("/api/custom-apps/store", { revalidateOnFocus: false });
  const [storeOpen, setStoreOpen] = React.useState(false);
  const address = useAddressChoice(d.id);
  const job = useJob(d, { beforeStart: () => draft.save(), onFinished: () => void mutate() });

  const heading = React.useRef<HTMLHeadingElement>(null);
  const moved = React.useRef(false);
  const setStep = React.useCallback(
    (next: DraftStep) => {
      moved.current = true;
      setStepState(next);
      const u = new URL(window.location.href);
      u.searchParams.set("draft", d.id);
      u.searchParams.set("step", next);
      u.searchParams.delete("from");
      window.history.replaceState(null, "", u.toString());
      window.scrollTo({ top: 0 });
    },
    [d.id],
  );

  // ---------------------------------------------------------------- checks (as the builder runs them)
  const ctx = React.useMemo(() => ({ source: d.source, target, web: draft.spec.web, secrets: draft.secrets }), [d.source, target, draft.spec.web, draft.secrets]);
  const analysis = React.useMemo(() => analyze(draft.spec.compose, ctx), [draft.spec.compose, ctx]);
  const local = React.useMemo(() => [...detailIssues(draft.spec, false), ...analysis.issues], [draft.spec, analysis.issues]);
  const withImages = step === "review";
  const [attempt, setAttempt] = React.useState(0);
  const checkKey = `${draft.state === "saved" ? "s" : "x"}:${d.rev}:${withImages}:${attempt}`;
  // Each answer is tied to the saved state it checked, so Review never shows an older one
  // (setup's check skips images) as if it covered this draft.
  const [answer, setAnswer] = React.useState<{ key: string; result: ServerCheck | null; error: string | null } | null>(null);
  const current = answer?.key === checkKey ? answer : null;
  const server = current?.result ?? null;
  const checking = !current;
  const checkError = current?.error ?? null;
  const [lastPorts, setLastPorts] = React.useState<ServerCheck["ports"]>([]);
  React.useEffect(() => {
    if (draft.state !== "saved" || step === "start") return;
    let cancelled = false;
    const key = checkKey;
    const t = setTimeout(async () => {
      try {
        const r = await api.post<ServerCheck>(`/api/custom-apps/${d.id}/check`, { images: withImages });
        if (!cancelled) {
          setAnswer({ key, result: r, error: null });
          setLastPorts(r.ports);
        }
      } catch (e) {
        if (!cancelled) setAnswer({ key, result: null, error: e instanceof Error ? e.message : "The check didn't answer." });
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  const issues: Issue[] = React.useMemo(() => {
    const ids = new Set(local.map((i) => i.id));
    return [...local, ...(server?.issues ?? []).filter((i) => !ids.has(i.id))];
  }, [local, server]);
  // Port hints may come from the last answer while a newer check runs; they're only hints.
  const ports = server?.ports ?? lastPorts;
  const usedPorts = React.useMemo(() => new Map(ports.map((p) => [p.port, p.by])), [ports]);
  React.useEffect(() => {
    if (moved.current) heading.current?.focus({ preventScroll: true });
  }, [step]);
  const fix = React.useCallback(
    (fixId: string) => {
      const r = applyFix(draft.spec.compose, fixId, ctx);
      if (!r) return toast.info("That's already fixed.");
      draft.setSpec((sp) => ({ ...sp, compose: r.text, web: { ...sp.web, ...r.web } }));
      for (const [svc, keys] of Object.entries(r.secrets ?? {})) for (const k of keys) draft.setSecret(svc, k, "");
      toast.success(r.said);
    },
    [draft, ctx],
  );

  const hasWeb = !!draft.spec.web.service && !!(draft.spec.web.port ?? draft.spec.web.containerPort);
  const afterSetup: DraftStep = hasWeb ? "address" : "review";
  const name = draft.spec.details.name.trim() || "the app";
  const startNow = () => {
    setStep("start");
    void job.start({ kind: "publish" });
  };

  const conflict =
    draft.state === "conflict" ? (
      <Notice
        tone="attention"
        title="Changed somewhere else"
        action={
          <Button size="sm" onClick={async () => draft.reset(await api.get<CustomAppDetail>(`/api/custom-apps/${d.id}`))}>
            Load the latest
          </Button>
        }
      >
        This app was changed in another tab or in the builder. Load the latest to keep going; what you typed since then isn&apos;t saved.
      </Notice>
    ) : null;

  return (
    <FlowFrame
      step={step}
      detail={d}
      draft={draft}
      working={step === "start" && (job.running || jobActive)}
      failed={step === "start" && job.view?.result?.ok === false}
      complete={step === "start" && job.view?.result?.ok === true}
      hasAddress={hasWeb}
    >
      {conflict && <div className={f.notice}>{conflict}</div>}
      <div key={step} className={f.stepIn} data-motion-gentle="">
        {/* Focus lands here after Continue or Back, which unmount with the old step. */}
        <h2 ref={heading} tabIndex={-1} className={`sr-only ${f.stepHeading}`}>
          {STEP_NAMES[step]}
        </h2>
        {step === "setup" && <SetupStep draft={draft} detail={d} services={analysis.services} yamlBroken={!analysis.parsed.ok} issues={issues} target={target} usedPorts={usedPorts} onFix={fix} onNext={() => setStep(afterSetup)} />}
        {step === "address" && <AddressStep draft={draft} name={name} choice={address} onBack={() => setStep("setup")} onNext={() => setStep("review")} />}
        {step === "review" && (
          <ReviewStep
            draft={draft}
            detail={d}
            issues={issues}
            checking={checking}
            checkError={checkError}
            onRecheck={() => setAttempt((n) => n + 1)}
            target={target}
            store={store ?? null}
            address={address.choice}
            onFix={fix}
            onBack={() => setStep(hasWeb ? "address" : "setup")}
            onSetUpStore={() => setStoreOpen(true)}
            onStart={startNow}
          />
        )}
        {step === "start" && <StartStep detail={d} job={job} target={target} address={address} onRetry={startNow} onBackToReview={() => setStep("review")} />}
      </div>
      <StoreSetupDialog
        open={storeOpen}
        onOpenChange={setStoreOpen}
        repair={!!store?.lost}
        onDone={(st) => {
          void mutateStore(st, { revalidate: false });
          setStoreOpen(false);
        }}
      />
    </FlowFrame>
  );
}
