"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import type { BuilderTarget, CustomAppDetail } from "@/lib/builder-types";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { DraftFlow, type DraftStep } from "./flow/DraftFlow";
import { FlowFrame } from "./flow/FlowFrame";
import { SourceStep, type CreateBody, type FlowSource } from "./flow/SourceStep";
import { clearSourceInputs, useSourceInputs } from "./flow/sourceInputs";
import f from "./flow/flow.module.css";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * Making an app, step by step: what to run, then the essentials, an optional public address, a
 * review of exactly what will run, and the start itself. The draft exists from the second step
 * on, so a reload (or the full builder) picks up where things were.
 */
export function NewAppView({ initialSource, initialDraft, initialStep, missingDraft, draftError, target }: { initialSource: FlowSource; initialDraft: CustomAppDetail | null; initialStep: DraftStep; missingDraft: boolean; draftError: string | null; target: BuilderTarget }) {
  const router = useRouter();
  const [source, setSource] = React.useState<FlowSource>(initialSource);
  const [detail, setDetail] = React.useState<CustomAppDetail | null>(initialDraft);
  const [busy, setBusy] = React.useState<"flow" | "builder" | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // One key per attempt: a double click or a retried request gets the same draft back.
  const key = React.useRef(newKey());
  const inflight = React.useRef(false);
  const io = useSourceInputs();

  const choose = (v: FlowSource) => {
    setSource(v);
    setError(null);
    window.history.replaceState(null, "", `/apps/new?from=${v}`);
  };

  async function create(body: CreateBody, then: "flow" | "builder") {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(then);
    setError(null);
    try {
      // The key stays until the draft is loaded: if anything below fails, trying again gets the
      // same draft back instead of making a second one.
      const r = await api.post<{ id: string }>(`/api/custom-apps?key=${key.current}`, body);
      if (then === "builder") {
        key.current = newKey();
        clearSourceInputs();
        return router.push(`/apps/custom/${r.id}`);
      }
      setLoading(true);
      const d = await api.get<CustomAppDetail>(`/api/custom-apps/${r.id}`);
      key.current = newKey();
      clearSourceInputs();
      window.history.replaceState(null, "", `/apps/new?draft=${r.id}&step=setup`);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gluon couldn't make the draft.");
    } finally {
      inflight.current = false;
      setBusy(null);
      setLoading(false);
    }
  }

  if (draftError) {
    return (
      <FlowFrame step="setup">
        <Notice tone="fault" title="Gluon couldn't load this draft" action={<Button size="sm" onClick={() => window.location.reload()}>Try again</Button>}>
          {draftError} The draft is still there; nothing was changed.
        </Notice>
      </FlowFrame>
    );
  }

  if (detail) return <DraftFlow key={detail.id} initial={detail} initialStep={initialDraft ? initialStep : "setup"} target={target} />;

  return (
    <FlowFrame step={loading ? "setup" : "source"}>
      {missingDraft && (
        <div className={f.notice}>
          <Notice title="That draft isn't here any more">It was deleted, or published and removed. Start again below; nothing else changed.</Notice>
        </div>
      )}
      {error && (
        <div className={f.notice}>
          <Notice tone="fault" title="The draft wasn't made">
            {error} Your input is still here; try again.
          </Notice>
        </div>
      )}
      {loading ? (
        <div className={f.stack} aria-busy>
          <Skeleton height={120} radius={12} />
          <Skeleton height={220} radius={12} />
        </div>
      ) : (
        <SourceStep source={source} onSource={choose} target={target} busy={busy} io={io} onCreate={(b, then) => void create(b, then)} />
      )}
    </FlowFrame>
  );
}
