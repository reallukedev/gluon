import * as React from "react";
import surface from "@/components/ui/surface.module.css";
import { Skeleton } from "@/components/ui/Surface";
import { AppsSectionTabs } from "@/components/docker/AppsSectionTabs";
import s from "./frame.module.css";

/**
 * The Apps section's frame: the title and tabs stay mounted across tabs, and each tab fills in the
 * summary, actions and body. One grid places them, so the summary still sits under the title and the
 * actions at the right, as on every other page.
 */
export function AppsFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.frame}>
      <h1 className={`${surface.title} ${s.title}`}>Apps</h1>
      <div className={s.tabs}>
        <AppsSectionTabs />
      </div>
      {children}
    </div>
  );
}

/** A tab's part of the header: its one sentence of state and its actions. */
export function AppsHead({ summary, actions }: { summary?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <>
      <p className={`${surface.summary} ${s.summary}`}>{summary ?? <Skeleton width="min(420px, 90%)" height={15} style={{ marginTop: 4 }} />}</p>
      {actions && <div className={`${surface.headerActions} ${s.actions}`}>{actions}</div>}
    </>
  );
}

/** Everything under the tabs. */
export function AppsBody({ children }: { children: React.ReactNode }) {
  return <div className={s.body}>{children}</div>;
}
