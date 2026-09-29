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
      <svg className={s.emptyGlyph} viewBox="0 0 44 20" fill="none" aria-hidden>
        {/* One end held, the other still open: nothing here yet. */}
        <circle cx="3" cy="14" r="2.4" fill="currentColor" />
        <path d="M3 14L4.5 13.9L5.8 13.4L7.1 12.8L8.1 11.9L8.9 10.9L9.4 9.8L9.7 8.7L9.6 7.7L9.3 6.8L8.8 6.2L8.2 5.7L7.5 5.6L6.8 5.7L6.2 6.2L5.7 6.8L5.4 7.7L5.3 8.7L5.5 9.8L6.1 10.9L6.9 11.9L7.9 12.8L9.2 13.4L10.5 13.9L12 14L13.5 13.9L14.8 13.4L16.1 12.8L17.1 11.9L17.9 10.9L18.4 9.8L18.7 8.7L18.6 7.7L18.3 6.8L17.9 6.2L17.2 5.7L16.5 5.6L15.8 5.7L15.2 6.2L14.7 6.8L14.4 7.7L14.3 8.7L14.6 9.8L15.1 10.9L15.9 11.9L16.9 12.8L18.1 13.4L19.5 13.9L21 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M24 14H37.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="0.1 3.2" />
        <circle cx="41" cy="14" r="2.4" stroke="currentColor" strokeWidth="1.3" strokeDasharray="1.6 1.4" />
      </svg>
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
