"use client";
import * as React from "react";
import type { CustomAppDetail } from "@/lib/builder-types";
import { Page, PageHeader } from "@/components/ui/Surface";
import { NavArrowLeft } from "iconoir-react";
import { Button, LinkButton } from "@/components/ui/Button";
import { FlowSteps } from "@/components/ui/FlowSteps";
import type { Draft } from "../state";
import { SaveLine } from "../SaveLine";
import f from "./flow.module.css";

export type FlowStepKey = "source" | "setup" | "address" | "review" | "start";

const STEPS: { key: FlowStepKey; label: string; description?: string }[] = [
  { key: "source", label: "What to run" },
  { key: "setup", label: "Set up" },
  { key: "address", label: "Public address", description: "Optional" },
  { key: "review", label: "Review" },
  { key: "start", label: "Start" },
];

interface Props {
  step: FlowStepKey;
  detail?: CustomAppDetail;
  draft?: Draft;
  working?: boolean;
  failed?: boolean;
  complete?: boolean;
  /** Without a web page there's nothing to publish, so the address step is left out. */
  hasAddress?: boolean;
  children: React.ReactNode;
}

/** The page around every step: where you are, one line of state, and the full builder one click away. */
export function FlowFrame({ step, detail, draft, working, failed, complete, hasAddress = true, children }: Props) {
  const name = draft?.spec.details.name.trim() || detail?.spec.details.name.trim() || "";
  const steps = STEPS.filter((x) => hasAddress || x.key !== "address");
  const summary =
    step === "source"
      ? "Pick what to run and Gluon sets the rest up with you. Nothing starts until the last step."
      : step === "start"
        ? complete
          ? `${name || "The app"} is running.`
          : failed
            ? `${name || "The app"} didn't start. The details are below.`
            : `Starting ${name || "the app"}. This page follows along, and it keeps going if you leave.`
        : step === "review"
          ? "This is exactly what will run. Nothing has started yet."
          : `${name || "This app"} is a draft, saved as you go. Nothing runs until you start it.`;
  return (
    <Page narrow>
      <PageHeader
        back={{ href: "/apps/custom", label: "Your apps" }}
        title={step === "source" || !name ? "Make an app" : step === "start" && complete ? name : `Set up ${name}`}
        summary={summary}
        actions={
          detail ? (
            <LinkButton href={`/apps/custom/${detail.id}`} variant="secondary">
              Open in the full builder
            </LinkButton>
          ) : undefined
        }
      />
      <FlowSteps className={f.steps} label="Making an app" steps={steps} current={step} working={working} failed={failed} complete={complete} />
      <div className={f.body}>{children}</div>
      {draft && step !== "start" && (
        <div className={f.save}>
          <SaveLine state={draft.state} savedAt={draft.savedAt} error={draft.error} onRetry={() => void draft.save()} />
        </div>
      )}
    </Page>
  );
}

/** Back on the left, the step's forward action on the right; on phones they share the width. */
export function FlowNav({ back, children }: { back?: { label: string; onClick: () => void }; children: React.ReactNode }) {
  return (
    <div className={f.nav}>
      {back ? (
        <Button variant="ghost" icon={<NavArrowLeft />} onClick={back.onClick}>
          {back.label}
        </Button>
      ) : (
        <span />
      )}
      <div className={f.navMain}>{children}</div>
    </div>
  );
}
