import * as React from "react";
import surface from "@/components/ui/surface.module.css";
import { Skeleton } from "@/components/ui/Surface";
import { AppsSectionTabs } from "@/components/docker/AppsSectionTabs";
import s from "./frame.module.css";

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

export function AppsHead({ summary, actions }: { summary?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <>
      <p className={`${surface.summary} ${s.summary}`}>{summary ?? <Skeleton width="min(420px, 90%)" height={15} style={{ marginTop: 4 }} />}</p>
      {actions && <div className={`${surface.headerActions} ${s.actions}`}>{actions}</div>}
    </>
  );
}

export function AppsBody({ children }: { children: React.ReactNode }) {
  return <div className={s.body}>{children}</div>;
}
