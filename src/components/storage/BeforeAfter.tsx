"use client";
import * as React from "react";
import Link from "next/link";
import { StateLine } from "@/components/ui/StateLine";
import type { LineState } from "@/lib/types";
import type { VolumeUser } from "@/lib/storage-types";
import s from "./storage.module.css";

export interface Side {
  state: LineState;
  /** One plain line: "Connected at /mnt/hdd2 until the next restart". */
  text: React.ReactNode;
  detail?: React.ReactNode;
}

/**
 * A change drawn as now → after: two short states side by side (stacked on phones), each with its
 * state line, so the person sees what's different before they press the button.
 */
export function BeforeAfter({ before, after }: { before: Side; after: Side }) {
  return (
    <div className={s.ba} role="group" aria-label="What changes">
      <div className={s.baSide}>
        <span className="label">Now</span>
        <p className={s.baText}>
          <StateLine state={before.state} size={13} />
          <span>{before.text}</span>
        </p>
        {before.detail && <div className={s.baDetail}>{before.detail}</div>}
      </div>
      <span className={s.baArrow} aria-hidden>
        <svg viewBox="0 0 24 12" width="24" height="12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 6h21M17 1.5 22 6l-5 4.5" />
        </svg>
      </span>
      <div className={s.baSide} data-after="">
        <span className="label">After</span>
        <p className={s.baText}>
          <StateLine state={after.state} size={13} />
          <span>{after.text}</span>
        </p>
        {after.detail && <div className={s.baDetail}>{after.detail}</div>}
      </div>
    </div>
  );
}

/** One line added to (or changed in) the startup list, as a diff. */
export function FstabChange({ line, before, after }: { line: number | null; before: string | null; after: string }) {
  return (
    <div className={s.stack}>
      <p className={s.baCaption}>
        The startup list <span className="mono">/etc/fstab</span> {before ? `changes on line ${line}` : "gets one line"}. A backup is saved first.
      </p>
      <div className={s.diff} role="group" aria-label="Change to /etc/fstab">
        {before && (
          <div className={s.diffLine} data-kind="del">
            <span className={`${s.diffNo} num`}>{line}</span>
            <span className={s.diffSign} aria-label="removed">
              −
            </span>
            <code>{before}</code>
          </div>
        )}
        <div className={s.diffLine} data-kind="add">
          <span className={`${s.diffNo} num`}>{line ?? ""}</span>
          <span className={s.diffSign} aria-label="added">
            +
          </span>
          <code>{after}</code>
        </div>
      </div>
    </div>
  );
}

/** The apps that keep files on a volume, as links, in a sentence. */
export function AppsUsing({ users, lead }: { users: VolumeUser[]; lead: (names: React.ReactNode, count: number) => React.ReactNode }) {
  const apps = [...new Map(users.map((u) => [u.appId, u])).values()];
  if (!apps.length) return null;
  const names = apps.map((u, i) => (
    <React.Fragment key={u.appId}>
      {i > 0 && (i === apps.length - 1 ? " and " : ", ")}
      <Link href={`/apps/${encodeURIComponent(u.appId)}`}>{u.app}</Link>
    </React.Fragment>
  ));
  return <p className={s.baApps}>{lead(<>{names}</>, apps.length)}</p>;
}
