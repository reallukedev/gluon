import * as React from "react";
import Link from "next/link";
import { NavArrowLeft } from "iconoir-react";
import s from "./surface.module.css";

export function Page({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return <div className={`${s.page} ${narrow ? s.pageNarrow : ""}`}>{children}</div>;
}

interface PageHeaderProps {
  title: React.ReactNode;
  /** One plain sentence of state: "Everything is running. 3 things need you." */
  summary?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}

export function PageHeader({ title, summary, actions, back }: PageHeaderProps) {
  return (
    <header className={s.header}>
      <div className={s.headerText}>
        {back && (
          <Link href={back.href} className={s.back}>
            <NavArrowLeft strokeWidth={2} />
            {back.label}
          </Link>
        )}
        <h1 className={s.title}>{title}</h1>
        {summary && <p className={s.summary}>{summary}</p>}
      </div>
      {actions && <div className={s.headerActions}>{actions}</div>}
    </header>
  );
}

interface PanelProps {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  as?: "section" | "div";
}

export function Panel({ title, meta, children, flush, className, id, as: Tag = "section" }: PanelProps) {
  const headingId = React.useId();
  return (
    <Tag className={`${s.panel} ${className ?? ""}`} id={id} aria-labelledby={title ? headingId : undefined}>
      {(title || meta) && (
        <div className={s.panelHead}>
          {title && (
            <h2 className={s.panelTitle} id={headingId}>
              {title}
            </h2>
          )}
          {meta && <div className={s.panelMeta}>{meta}</div>}
        </div>
      )}
      <div className={flush ? s.flush : s.panelBody}>{children}</div>
    </Tag>
  );
}

export function Section({ title, meta, children, id }: { title: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className={s.section} id={id}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>{title}</h2>
        {meta && <div className={s.sectionMeta}>{meta}</div>}
      </div>
      {children}
    </section>
  );
}

/** Empty states teach: what this place is for and how to fill it. */
export function Empty({ title, children, action, center }: { title: string; children?: React.ReactNode; action?: React.ReactNode; center?: boolean }) {
  return (
    <div className={`${s.empty} ${center ? s.emptyCenter : ""}`}>
      <div className={s.emptyGlyph} aria-hidden>
        <i style={{ height: "100%" }} />
        <i style={{ height: "60%" }} />
        <i style={{ height: "85%", opacity: 0.4 }} />
        <i style={{ height: "40%" }} />
      </div>
      <p className={s.emptyTitle}>{title}</p>
      {children && <div className={s.emptyBody}>{children}</div>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, radius, style }: { width?: number | string; height?: number | string; radius?: number; style?: React.CSSProperties }) {
  return <span className={s.skeleton} aria-hidden data-motion-gentle="" style={{ display: "block", width, height, borderRadius: radius, ...style }} />;
}

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "attention" | "fault";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={s.notice} data-tone={tone} role={tone === "fault" ? "alert" : "status"}>
      <span className={s.noticeMark} aria-hidden />
      <div className={s.noticeText}>
        {title && <div className={s.noticeTitle}>{title}</div>}
        {children && <div className={s.noticeBody}>{children}</div>}
      </div>
      {action ? <div className={s.noticeAction}>{action}</div> : <span />}
    </div>
  );
}

/** A usage bar that turns attention/fault past thresholds. Accessible as a meter. */
export function UsageBar({
  value,
  max = 100,
  attention,
  fault,
  label,
}: {
  value: number;
  max?: number;
  attention?: number;
  fault?: number;
  label: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const level = fault !== undefined && pct >= fault ? "fault" : attention !== undefined && pct >= attention ? "attention" : "normal";
  return (
    <div className={s.usage} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)}>
      <div className={s.usageTrack}>
        <div className={s.usageFill} data-level={level} style={{ width: `${pct}%` }} data-motion-gentle="" />
        {attention !== undefined && <span className={s.usageTick} style={{ left: `${attention}%` }} />}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

export function DefinitionList({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className={s.dl}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
