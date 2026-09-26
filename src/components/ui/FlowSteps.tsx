"use client";
/**
 * FlowSteps — where you are in a guided flow (set up a disk, rename a mount, two-step setup).
 *
 *   <FlowSteps
 *     label="Set up a new disk"
 *     steps={[{ key: "look", label: "Check the disk" }, { key: "name", label: "Name it" }, { key: "run", label: "Format" }]}
 *     current="name"
 *   />
 *
 * States follow the StateLine grammar: done = solid ink, current = ink with its label in ink,
 * working = dashed (pass `working` while the current step runs), failed = short red with the
 * word "failed" (pass `failed`), upcoming = faint. Horizontal from 640px, a vertical list on phones.
 * The hairline between two steps fills left to right (250ms, --ease-out) as a step completes;
 * reduced motion shows it filled without the sweep. Labels only — no step numbers.
 */
import * as React from "react";
import s from "./flowSteps.module.css";

export interface FlowStep {
  key: string;
  label: string;
  /** One short line under the label (shown on the current step, and always on phones). */
  description?: string;
}

interface FlowStepsProps {
  steps: FlowStep[];
  current: string;
  /** The current step is running (dashed line). */
  working?: boolean;
  /** The current step failed (short red line). */
  failed?: boolean;
  /** Every step is complete. */
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
