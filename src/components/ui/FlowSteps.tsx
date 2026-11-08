"use client";
import s from "./flowSteps.module.css";

export interface FlowStep {
  key: string;
  label: string;
  description?: string;
}

interface FlowStepsProps {
  steps: FlowStep[];
  current: string;
  working?: boolean;
  failed?: boolean;
  complete?: boolean;
  label: string;
  className?: string;
}

type State = "done" | "current" | "working" | "failed" | "upcoming";

export function FlowSteps({ steps, current, working, failed, complete, label, className }: FlowStepsProps) {
  const at = Math.max(0, steps.findIndex((x) => x.key === current));
  return (
    <ol className={`${s.steps} ${className ?? ""}`} aria-label={label}>
      {steps.map((step, i) => {
        const state: State = complete || i < at ? "done" : i > at ? "upcoming" : failed ? "failed" : working ? "working" : "current";
        return (
          <li key={step.key} className={s.step} data-state={state} aria-current={i === at && !complete ? "step" : undefined}>
            <span className={s.mark} aria-hidden data-motion-gentle="" />
            <span className={s.text}>
              <span className={s.label}>{step.label}</span>
              {state === "failed" && <span className={s.state}>failed</span>}
              {step.description && <span className={s.description}>{step.description}</span>}
            </span>
            <span className="sr-only">
              {state === "done" ? ", done" : state === "working" ? ", in progress" : state === "upcoming" ? ", to do" : ""}
            </span>
            {i < steps.length - 1 && <span className={s.link} aria-hidden data-motion-gentle="" />}
          </li>
        );
      })}
    </ol>
  );
}
