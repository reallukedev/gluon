"use client";
import * as React from "react";
import type { Finding } from "@/server/findings";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { RemedyButton } from "@/components/status/NeedsYou";
import { byDay, dayLabel, errorMessage } from "./shared";
import s from "./alerts.module.css";

export const isSnoozed = (f: Finding, now = Date.now()) => !!f.snoozedUntil && f.snoozedUntil > now;

// ---------------------------------------------------------------- quiet

/**
 * The rest of the open list, under Status's "Needs you": things worth knowing (no alerts are sent),
 * snoozed ones and ones marked as not a problem, each with a way back onto the list.
 */
export function QuietFindings({ findings, onChange }: { findings: Finding[]; onChange: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  async function restore(f: Finding) {
    setBusy(f.id);
    try {
      await api.post(`/api/findings/${encodeURIComponent(f.id)}`, { op: "restore" });
      toast.info("Back on the list");
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const now = Date.now();
  const info = findings.filter((f) => !f.dismissedAt && !isSnoozed(f, now) && f.severity === "info");
  const snoozed = findings.filter((f) => !f.dismissedAt && isSnoozed(f, now));
  const dismissed = findings.filter((f) => f.dismissedAt);
  const back = (f: Finding) => (
    <Button size="sm" loading={busy === f.id} onClick={() => void restore(f)}>
      Show it again
    </Button>
  );

  return (
    <>
      {info.length > 0 && (
        <Panel title="Worth knowing" meta={<span className={s.panelNote}>No alerts are sent for these</span>} flush>
          <FindingList items={info} actions={(f) => (f.remedy ? <RemedyButton remedy={f.remedy} findingId={f.id} onDone={onChange} /> : null)} />
        </Panel>
      )}
      {snoozed.length > 0 && (
        <Panel title="Snoozed" meta={<span className={s.panelNote}>Each comes back at its time if it's still true</span>} flush>
          <FindingList quiet items={snoozed} note={(f) => <>back <Time ts={f.snoozedUntil!} kind="dateTime" /></>} actions={back} />
        </Panel>
      )}
      {dismissed.length > 0 && (
        <Panel title="Marked as not a problem" meta={<span className={s.panelNote}>Back on the list if it clears and happens again</span>} flush>
          <FindingList quiet items={dismissed} note={(f) => <>hidden <Time ts={f.dismissedAt!} /></>} actions={back} />
        </Panel>
      )}
    </>
  );
}

function FindingList({
  items,
  actions,
  note,
  quiet,
  settled,
}: {
  items: Finding[];
  actions: (f: Finding) => React.ReactNode;
  note?: (f: Finding) => React.ReactNode;
  quiet?: boolean;
  settled?: Set<string>;
}) {
  return (
    <ul className={s.findings} role="list">
      {items.map((f) => {
        const done = settled?.has(f.id);
        return (
          <li key={f.id} id={f.id} className={s.finding} data-severity={f.severity} data-quiet={quiet ? "" : undefined} data-settled={done ? "" : undefined}>
            <span className={s.mark} data-motion-gentle="" role="img" aria-label={done ? "Fixed, waiting to confirm" : f.severity === "fault" ? "Broken" : f.severity === "attention" ? "Needs you" : "Worth knowing"} />
            <div className={s.findingText}>
              <p className={s.findingTitle}>{f.title}</p>
              {f.cause && <p className={s.findingCause}>{f.cause}</p>}
              <p className={s.findingMeta}>
                {done ? (
                  <span className={s.settledNote}>Done. Gluon confirms it on its next check.</span>
                ) : (
                  <>
                    {f.subject && (
                      <span className="mono truncate" title={f.subject} style={{ maxWidth: "32ch" }}>
                        {f.subject}
                      </span>
                    )}
                    <span>
                      First noticed <Time ts={f.firstSeen} />
                    </span>
                    {note && <span>{note(f)}</span>}
                  </>
                )}
              </p>
            </div>
            {!done && <div className={s.findingActions}>{actions(f)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- history

export function HistoryTab() {
  const fmt = useFormat();
  const { data, error, isLoading } = useApi<Finding[]>("/api/findings?view=history", { refresh: 60_000 });
  if (error && !data) {
    return (
      <Notice tone="fault" title="Couldn't load the history">
        {error.message} Try again in a moment.
      </Notice>
    );
  }
  if (isLoading && !data) {
    return (
      <Panel flush>
        <div className={s.skeletons}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={44} />
          ))}
        </div>
      </Panel>
    );
  }
  const items = data ?? [];
  if (!items.length) {
    return (
      <Panel flush>
        <Empty title="No history yet">Problems that were found and then cleared, by a fix or on their own, are listed here with how long they lasted.</Empty>
      </Panel>
    );
  }
  const days = byDay(items, (f) => f.resolvedAt ?? f.lastSeen, (ts) => fmt.date(ts, { year: true }));
  return (
    <Panel title="Cleared problems" meta={<span className="num">last {items.length}</span>} flush>
      <ul className={`${s.hist} appear`} role="list">
        {days.map((d) => (
          <React.Fragment key={d.day}>
            <li className={s.day}>
              <span className="label">{dayLabel(d.ts, fmt.date)}</span>
              <span className={`${s.dayCount} num`}>{fmt.plural(d.items.length, "problem")} cleared</span>
            </li>
            {d.items.map((f) => {
              const lasted = ((f.resolvedAt ?? f.lastSeen) - f.firstSeen) / 1000;
              return (
                <li key={`${f.id}:${f.firstSeen}`} className={s.histRow} data-severity={f.severity}>
                  <Time ts={f.resolvedAt ?? f.lastSeen} kind="time" className={`${s.histTime} num`} />
                  <span className={s.histMark} aria-label={f.severity === "fault" ? "Was broken" : "Needed attention"} />
                  <span className={s.histText}>
                    <span className={s.histTitle}>{f.title}</span>
                    <span className={s.histSub}>
                      {f.subject && <span className="mono">{f.subject}</span>}
                      {f.dismissedAt && <span>marked as not a problem</span>}
                    </span>
                  </span>
                  <span className={`${s.histEnd} num`}>lasted {lasted < 60 ? "under a minute" : fmt.duration(lasted, 2)}</span>
                </li>
              );
            })}
          </React.Fragment>
        ))}
      </ul>
    </Panel>
  );
}
