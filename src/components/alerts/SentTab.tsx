"use client";
import * as React from "react";
import type { ChannelView, DeliveryEntry, DeliveryPage, DeliveryStatus } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { LineState } from "@/lib/types";
import { byDay, CHANNELS_URL, dayLabel, errorMessage } from "./shared";
import s from "./alerts.module.css";

type Show = "all" | DeliveryStatus;

const EVENT: Record<DeliveryEntry["event"], string> = { problem: "Alert", resolved: "All clear", digest: "Daily summary", report: "Report reply" };
const LINE: Record<DeliveryStatus, { line: LineState; label: string }> = {
  sent: { line: "running", label: "Sent" },
  pending: { line: "starting", label: "Waiting" },
  failed: { line: "unhealthy", label: "Failed" },
  cancelled: { line: "stopped", label: "Not sent" },
};

/** Everything Gluon sent (or tried to), newest first, with retry for failures. Members only ever get their own channels' messages. */
export function SentTab({ compact }: { compact?: boolean }) {
  const fmt = useFormat();
  const [show, setShow] = React.useState<Show>("all");
  const [channel, setChannel] = React.useState("");
  const [older, setOlder] = React.useState<DeliveryEntry[]>([]);
  const [next, setNext] = React.useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [openId, setOpenId] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<number | null>(null);

  const qs = new URLSearchParams({ limit: compact ? "20" : "50" });
  if (show !== "all") qs.set("status", show);
  if (channel) qs.set("channel", channel);
  const url = `/api/alerts/deliveries?${qs}`;
  const { data, error, isLoading, mutate } = useApi<DeliveryPage>(url, { refresh: 20_000 });
  const { data: channels } = useApi<ChannelView[]>(compact ? null : CHANNELS_URL);

  React.useEffect(() => {
    setOlder([]);
    setNext(undefined);
  }, [url]);

  const cursor = next === undefined ? (data?.next ?? null) : next;
  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await api.get<DeliveryPage>(`${url}&before=${cursor}`);
      setOlder((o) => [...o, ...p.items]);
      setNext(p.next);
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't load older messages."));
    } finally {
      setLoadingMore(false);
    }
  }
  async function retry(d: DeliveryEntry) {
    setBusy(d.id);
    try {
      await api.post("/api/alerts/deliveries", { op: "retry", id: d.id });
      toast.info("Sending it again", { description: "It should go out within a few seconds." });
      setTimeout(() => void mutate(), 3000);
      void mutate();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const seen = new Set<number>();
  const items = [...(data?.items ?? []), ...older].filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const days = byDay(items, (d) => d.createdAt, (ts) => fmt.date(ts, { year: true }));

  return (
    <>
      {!compact && (
        <div className={s.toolbar}>
          <Segmented
            aria-label="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: "All" },
              { value: "sent", label: "Sent" },
              { value: "pending", label: "Waiting" },
              { value: "failed", label: "Failed" },
            ]}
          />
          {(channels?.length ?? 0) > 1 && (
            <Select
              aria-label="Channel"
              value={channel}
              onChange={setChannel}
              options={[{ value: "", label: "Every channel" }, ...(channels ?? []).map((c) => ({ value: c.id, label: c.ownerName ? `${c.name} (${c.ownerName})` : c.name }))]}
            />
          )}
        </div>
      )}
      <Panel title={compact ? "Recently sent" : undefined} flush>
        {error && !data ? (
          <div className={s.pad}>
            <Notice tone="fault" title="Couldn't load the log">
              {error.message}
            </Notice>
          </div>
        ) : isLoading && !data ? (
          <div className={s.skeletons}>
            {Array.from({ length: compact ? 3 : 6 }, (_, i) => (
              <Skeleton key={i} height={44} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty title={show === "failed" ? "Nothing failed" : show === "pending" ? "Nothing is waiting" : "Nothing sent yet"}>
            {show === "all"
              ? "Every alert, all-clear and daily summary Gluon sends is listed here, with whether it got through. Messages held back by quiet hours wait here too."
              : "Try another filter."}
          </Empty>
        ) : (
          <ul className={`${s.hist} appear`} role="list">
            {days.map((g) => (
              <React.Fragment key={g.day}>
                <li className={s.day}>
                  <span className="label">{dayLabel(g.ts, fmt.date)}</span>
                  <DayCounts items={g.items} />
                </li>
                {g.items.map((d) => {
                  const st = LINE[d.status];
                  const open = openId === d.id;
                  return (
                    <li key={d.id} className={s.sentRow} data-status={d.status}>
                      <Time ts={d.createdAt} kind="time" className={`${s.histTime} num`} />
                      <StateLine state={st.line} label={false} />
                      <span className={s.histText}>
                        <span className={s.histTitle}>{d.title}</span>
                        <span className={s.histSub}>
                          <span>{EVENT[d.event]}</span>
                          <span>to {d.channelName}</span>
                          <span>{st.label}</span>
                          {d.status === "pending" && d.notBefore > Date.now() && (
                            <span>
                              held for quiet hours until <Time ts={d.notBefore} kind="time" />
                            </span>
                          )}
                          {d.status === "pending" && d.attempts > 0 && (
                            <span>
                              tried {fmt.plural(d.attempts, "time")}, next <Time ts={d.nextAttemptAt} />
                            </span>
                          )}
                          {d.status === "sent" && d.sentAt && d.sentAt - d.createdAt > 90_000 && (
                            <span>
                              went out <Time ts={d.sentAt} kind="time" />
                            </span>
                          )}
                        </span>
                        {d.lastError && d.status !== "sent" && <span className={s.sentErr}>{d.lastError}</span>}
                        <Disclosure summary="Message" open={open} onOpenChange={(o) => setOpenId(o ? d.id : null)}>
                          <span className={s.sentBody}>{d.body || "(no text)"}</span>
                        </Disclosure>
                      </span>
                      <span className={s.sentEnd}>
                        {d.status === "failed" && d.channelId && (
                          <Button size="sm" loading={busy === d.id} onClick={() => void retry(d)}>
                            Send again
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </React.Fragment>
            ))}
            {cursor && (
              <li className={s.more}>
                <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                  Show older
                </Button>
              </li>
            )}
          </ul>
        )}
      </Panel>
    </>
  );
}

function DayCounts({ items }: { items: DeliveryEntry[] }) {
  const sent = items.filter((d) => d.status === "sent").length;
  const failed = items.filter((d) => d.status === "failed").length;
  const waiting = items.filter((d) => d.status === "pending").length;
  const parts = [`${sent} sent`, failed ? `${failed} failed` : null, waiting ? `${waiting} waiting` : null].filter(Boolean);
  return <span className={`${s.dayCount} num`}>{parts.join(" · ")}</span>;
}
