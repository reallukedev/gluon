"use client";
import * as React from "react";
import { Clock, EyeClosed, MoreHoriz } from "iconoir-react";
import type { Finding } from "@/server/findings";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { RemedyButton } from "@/components/status/NeedsYou";
import { byDay, dayLabel, errorMessage, FINDINGS_URL } from "./shared";
import s from "./alerts.module.css";

export const isSnoozed = (f: Finding, now = Date.now()) => !!f.snoozedUntil && f.snoozedUntil > now;
/** Counts toward "needs you": not dismissed, not snoozed, not informational. */
export const isActive = (f: Finding) => !f.dismissedAt && !isSnoozed(f) && f.severity !== "info";

// ---------------------------------------------------------------- open

/** Hours from now until 8 in the morning tomorrow (a "not now, first thing tomorrow" snooze). */
function hoursUntilMorning(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return Math.max(1, Math.round((d.getTime() - Date.now()) / 3_600_000));
}

export function OpenTab({ findings }: { findings: Finding[] }) {
  const { mutate, error } = useApi<Finding[]>(FINDINGS_URL);
  const refresh = React.useCallback(() => void mutate(), [mutate]);
  /** Items just fixed with their remedy: their doubled line settles while Gluon confirms. */
  const [settled, setSettled] = React.useState<Set<string>>(() => new Set());
  const settle = React.useCallback(
    (id: string) => {
      setSettled((cur) => new Set(cur).add(id));
      refresh();
      window.setTimeout(() => {
        setSettled((cur) => {
          const n = new Set(cur);
          n.delete(id);
          return n;
        });
        refresh();
      }, 60_000);
    },
    [refresh],
  );

  async function op(f: Finding, body: Record<string, unknown>, message: string, description?: string) {
    try {
      await api.post(`/api/findings/${encodeURIComponent(f.id)}`, body);
      toast.info(message, {
        description,
        action:
          body.op !== "restore"
            ? { label: "Undo", onClick: () => void api.post(`/api/findings/${encodeURIComponent(f.id)}`, { op: "restore" }).then(refresh) }
            : undefined,
      });
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const now = Date.now();
  const live = findings.filter((f) => !f.dismissedAt && !isSnoozed(f, now));
  const broken = live.filter((f) => f.severity === "fault");
  const attention = live.filter((f) => f.severity === "attention");
  const info = live.filter((f) => f.severity === "info");
  const snoozed = findings.filter((f) => !f.dismissedAt && isSnoozed(f, now));
  const dismissed = findings.filter((f) => f.dismissedAt);

  const later = (f: Finding) => (
    <>
      <Menu
        trigger={
          <Button size="sm" variant="ghost" icon={<Clock />}>
            Snooze
          </Button>
        }
        items={[
          { kind: "label", label: "Hide it and hold its alerts" },
          { label: "For an hour", onSelect: () => void op(f, { op: "snooze", hours: 1 }, "Snoozed for an hour", "It comes back then if it's still true.") },
          { label: "Until tomorrow morning", onSelect: () => void op(f, { op: "snooze", hours: hoursUntilMorning() }, "Snoozed until tomorrow morning", "It comes back then if it's still true.") },
          { label: "For a week", onSelect: () => void op(f, { op: "snooze", hours: 24 * 7 }, "Snoozed for a week", "It comes back then if it's still true.") },
        ]}
      />
      <Menu
        trigger={
          <IconButton label="More options" size="sm">
            <MoreHoriz />
          </IconButton>
        }
        items={[
          {
            label: "This isn't a problem",
            description: "Hidden until it clears. If it happens again, it's back.",
            icon: <EyeClosed />,
            onSelect: () => void op(f, { op: "dismiss" }, "Marked as not a problem", "If it clears and happens again, it's back on the list."),
          },
        ]}
      />
    </>
  );
  const restore = (f: Finding) => (
    <Button size="sm" onClick={() => void op(f, { op: "restore" }, "Back on the list")}>
      Show it again
    </Button>
  );
  const active = (f: Finding) => (
    <>
      {f.remedy && <RemedyButton remedy={f.remedy} findingId={f.id} onDone={() => settle(f.id)} />}
      {later(f)}
    </>
  );

  return (
    <>
      {error && (
        <Notice tone="fault" title="Couldn't refresh the list">
          {error.message} What you see may be out of date.
        </Notice>
      )}
      {broken.length + attention.length === 0 ? (
        <Panel flush>
          <Empty title="Nothing needs you.">
            Gluon checks disks, apps, certificates, monitors and updates around the clock. Problems show up here with the fix next to them, and you're told
            through your notification channels.
          </Empty>
        </Panel>
      ) : (
        <>
          {broken.length > 0 && (
            <Panel title="Broken" meta={<span className="num">{broken.length}</span>} flush>
              <FindingList items={broken} settled={settled} actions={active} />
            </Panel>
          )}
          {attention.length > 0 && (
            <Panel title="Needs you" meta={<span className="num">{attention.length}</span>} flush>
              <FindingList items={attention} settled={settled} actions={active} />
            </Panel>
          )}
        </>
      )}
      {info.length > 0 && (
        <Panel title="Worth knowing" meta={<span className={s.panelNote}>No alerts are sent for these</span>} flush>
          <FindingList items={info} settled={settled} actions={(f) => (f.remedy ? <RemedyButton remedy={f.remedy} findingId={f.id} onDone={() => settle(f.id)} /> : null)} />
        </Panel>
      )}
      {snoozed.length > 0 && (
        <Panel title="Snoozed" meta={<span className={s.panelNote}>Each comes back at its time if it's still true</span>} flush>
          <FindingList quiet items={snoozed} note={(f) => <>back <Time ts={f.snoozedUntil!} kind="dateTime" /></>} actions={(f) => restore(f)} />
        </Panel>
      )}
      {dismissed.length > 0 && (
        <Panel title="Marked as not a problem" meta={<span className={s.panelNote}>Back on the list if it clears and happens again</span>} flush>
          <FindingList quiet items={dismissed} note={(f) => <>hidden <Time ts={f.dismissedAt!} /></>} actions={(f) => restore(f)} />
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
                      since <Time ts={f.firstSeen} />
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
