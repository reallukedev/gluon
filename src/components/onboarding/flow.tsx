"use client";
import * as React from "react";
import { NavArrowLeft } from "iconoir-react";
import type { AdminPlan, MemberPlan, Plan, StepId } from "@/lib/onboarding";
import { Button } from "@/components/ui/Button";
import o from "./onboarding.module.css";

export interface Flow {
  plan: Plan;
  step: StepId;
  /** Go to the next step (or finish after the last). */
  next: () => void;
  /** Go to the previous step; undefined on the first. */
  back?: () => void;
  /** Mark first run done and leave for `to` (Home by default). */
  finish: (to?: string) => void;
  /** Finishing is in flight (buttons show it). */
  leaving: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export const FlowContext = React.createContext<Flow | null>(null);

export function useFlow(): Flow {
  const f = React.useContext(FlowContext);
  if (!f) throw new Error("useFlow outside the welcome flow");
  return f;
}

export function useAdminPlan(): AdminPlan {
  const { plan } = useFlow();
  if (plan.role !== "admin") throw new Error("admin step in a member flow");
  return plan;
}

export function useMemberPlan(): MemberPlan {
  const { plan } = useFlow();
  if (plan.role !== "member") throw new Error("member step in an admin flow");
  return plan;
}

/** The step's title (focused when the step changes, so screen readers hear where they are) and lede. */
export function StepHead({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  const { headingRef } = useFlow();
  return (
    <header className={o.head}>
      <h1 ref={headingRef} tabIndex={-1} className={o.title}>
        {title}
      </h1>
      {children && <div className={o.lede}>{children}</div>}
    </header>
  );
}

/**
 * The step's way on. Back sits on the left; the skip (named for what skipping means) and the one
 * primary action on the right. On phones the bar sticks to the bottom, primary full width under
 * the thumb.
 */
export function Actions({ primary, skip, back = true }: { primary?: React.ReactNode; skip?: { label: string; onClick: () => void; disabled?: boolean }; back?: boolean }) {
  const flow = useFlow();
  const showBack = back && !!flow.back;
  return (
    <div className={o.actions}>
      <div className={o.actionsStart}>
        {showBack && (
          <span className={o.back}>
            <Button variant="ghost" icon={<NavArrowLeft />} onClick={flow.back} disabled={flow.leaving}>
              Back
            </Button>
          </span>
        )}
      </div>
      <div className={o.actionsEnd}>
        {skip && (
          <span className={o.skip}>
            <Button variant="ghost" onClick={skip.onClick} disabled={skip.disabled || flow.leaving}>
              {skip.label}
            </Button>
          </span>
        )}
        {primary && <span className={o.primary}>{primary}</span>}
      </div>
    </div>
  );
}

/** A part that couldn't be read: says which, offers another go, keeps the technical bit folded away. */
export function PartError({ message, detail, onRetry }: { message: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className={o.partError} role="alert">
      <span className={o.faultMark} aria-hidden />
      <div className={o.partErrorText}>
        <span>{message}</span>
        {detail && <span className={o.partErrorDetail}>{detail}</span>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** "Alex" from "Alex Smith"; the username when there's no name. */
export function firstName(displayName: string, fallback: string): string {
  return displayName.trim().split(/\s+/)[0] || fallback;
}

/** An hour of the day in the person's clock style: "04:00" or "4 AM". */
export function hourLabel(h: number, clock: "auto" | "12" | "24"): string {
  if (clock === "24") return `${String(h).padStart(2, "0")}:00`;
  if (clock === "12") return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
