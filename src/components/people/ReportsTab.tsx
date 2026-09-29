"use client";
import * as React from "react";
import { Eye, MoreHoriz, Trash } from "iconoir-react";
import type { ProblemReport } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Empty, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented, TextArea } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Time } from "@/components/ui/Time";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { Avatar, errorMessage, LoadError, REPORTS_URL, ReportSteps, reportStage, type ReportStage } from "./bits";
import s from "./people.module.css";

type Show = "new" | "seen" | "fixed" | "all";

/** Problem reports from the household as a small inbox: new → seen → fixed. */
export function ReportsTab({ focus }: { focus: string | null }) {
  const { data, error, isLoading, mutate } = useApi<ProblemReport[]>(REPORTS_URL, { refresh: 30_000 });
  const [show, setShow] = React.useState<Show | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const all = data ?? [];
  const count = (st: ReportStage) => all.filter((r) => reportStage(r) === st).length;
  const nNew = count("sent");
  const nSeen = count("seen");
  // Open on whatever needs looking at, and on the report a link points to.
  const focused = focus ? all.find((r) => r.id === focus) : undefined;
  const auto: Show = focused ? (reportStage(focused) === "sent" ? "new" : reportStage(focused) === "seen" ? "seen" : "fixed") : nNew ? "new" : nSeen ? "seen" : "all";
  const view = show ?? auto;
  const items = all.filter((r) => {
    const st = reportStage(r);
    return view === "all" || (view === "new" && st === "sent") || (view === "seen" && st === "seen") || (view === "fixed" && st === "fixed");
  });

  React.useEffect(() => {
    if (focus && data?.some((r) => r.id === focus)) document.getElementById(`report-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, data]);

  const remove = (r: ProblemReport) =>
    confirm({
      title: "Delete this report?",
      consequences: [`${r.userName ?? "The person who sent it"} won't see it or your reply any more.`, "Its alert is closed."],
      confirmLabel: "Delete report",
      onConfirm: async () => {
        await api.del(`/api/household/reports/${encodeURIComponent(r.id)}`);
        toast.success("Report deleted");
        void mutate();
      },
    });

  return (
    <>
      {all.length > 0 && (
      <div className={s.inboxBar}>
        <Segmented
          aria-label="Show"
          value={view}
          onChange={setShow}
          options={[
            { value: "new", label: nNew ? `New ${nNew}` : "New" },
            { value: "seen", label: nSeen ? `Seen ${nSeen}` : "Seen" },
            { value: "fixed", label: "Fixed" },
            { value: "all", label: "All" },
          ]}
        />
        <p className={s.hint}>Mark a report as seen and its sender knows you're on it. Replies reach them on their Status page.</p>
      </div>
      )}
      {error && !data ? (
        <LoadError what="problem reports" error={error} />
      ) : (
        <Panel flush>
          {isLoading && !data ? (
            <div className={s.skeletons}>
              <Skeleton height={60} />
              <Skeleton height={60} />
            </div>
          ) : items.length === 0 ? (
            <Empty title={view === "new" ? "No new reports" : view === "seen" ? "Nothing you're working on" : view === "fixed" ? "Nothing fixed yet" : "No reports yet"}>
              When someone in the household taps “Something's not working” on their Status page, it lands here and you're alerted. Mark it as seen, reply, and mark it
              fixed; they see each step on their Status page and, if they've set it up, get a message when you reply.
            </Empty>
          ) : (
            <ul className={`${s.reports} appear`} role="list">
              {items.map((r) => (
                <ReportItem key={r.id} r={r} focused={r.id === focus} onChange={() => void mutate()} onDelete={() => remove(r)} />
              ))}
            </ul>
          )}
        </Panel>
      )}
      {confirmNode}
    </>
  );
}

function ReportItem({ r, focused, onChange, onDelete }: { r: ProblemReport; focused: boolean; onChange: () => void; onDelete: () => void }) {
  const [reply, setReply] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const stage = reportStage(r);
  const who = r.userName ?? "They";

  async function send(body: { reply?: string | null; resolved?: boolean; acknowledged?: boolean }, what: string) {
    setBusy(what);
    try {
      await api.patch(`/api/household/reports/${encodeURIComponent(r.id)}`, body);
      const title =
        body.reply && body.resolved ? "Replied and marked fixed" : body.reply ? "Reply sent" : body.resolved ? "Marked fixed" : body.resolved === false ? "Reopened" : body.acknowledged ? "Marked as seen" : "Marked as new";
      const description = body.reply ? `${who} sees it on their Status page.` : body.acknowledged ? `${who} can see you're on it.` : body.resolved ? `${who} sees it's fixed.` : undefined;
      toast.success(title, description ? { description } : undefined);
      setReply("");
      setEditing(false);
      onChange();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const text = reply.trim();

  return (
    <li id={`report-${r.id}`} className={s.report} data-stage={stage} data-focus={focused ? "" : undefined}>
      <span className={s.reportMark} aria-hidden />
      <Avatar name={r.userName ?? "?"} />
      <div className={s.reportMain}>
        <div className={s.reportHead}>
          <b>{r.userName ?? "Someone (account removed)"}</b>
          <span>{r.appName ? `about ${r.appName}` : "about something else"}</span>
          <Time ts={r.createdAt} />
          <span className={s.reportMenu}>
            <Menu
              trigger={
                <IconButton label="Report actions" size="sm">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                ...(stage === "fixed" ? [{ label: "Reopen", description: `${who} sees it's being looked at again`, onSelect: () => void send({ resolved: false }, "reopen") }] : []),
                ...(stage === "seen" && !r.reply ? [{ label: "Mark as new", onSelect: () => void send({ acknowledged: false }, "unseen") }] : []),
                ...(r.reply ? [{ label: "Change the reply", onSelect: () => (setReply(r.reply ?? ""), setEditing(true)) }] : []),
                "separator" as const,
                { label: "Delete", icon: <Trash />, danger: true, onSelect: onDelete },
              ]}
            />
          </span>
        </div>
        <p className={s.reportMsg}>{r.message}</p>
        <ReportSteps stage={stage} />
        {r.reply && !editing && (
          <div className={s.reply}>
            <span className={s.replyHead}>
              {r.repliedByName ?? "You"} replied {r.repliedAt ? <Time ts={r.repliedAt} /> : null}
            </span>
            {r.reply}
          </div>
        )}
        {editing ? (
          <div className={s.replyBox}>
            <TextArea aria-label={`Reply to ${r.userName ?? "this report"}`} rows={3} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="e.g. Restarted it, try again now." autoFocus />
            <div className={s.replyActions}>
              {stage !== "fixed" && (
                <Button size="sm" variant="primary" disabled={!text} loading={busy === "both"} onClick={() => void send({ reply: text, resolved: true }, "both")}>
                  Reply and mark fixed
                </Button>
              )}
              <Button size="sm" variant={stage === "fixed" ? "primary" : "secondary"} disabled={!text} loading={busy === "reply"} onClick={() => void send({ reply: text }, "reply")}>
                {r.reply ? "Save reply" : "Just reply"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          stage !== "fixed" && (
            <div className={s.replyActions}>
              {stage === "sent" && (
                <Button size="sm" icon={<Eye />} loading={busy === "seen"} onClick={() => void send({ acknowledged: true }, "seen")}>
                  Mark as seen
                </Button>
              )}
              {!r.reply && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Reply
                </Button>
              )}
              <Button size="sm" variant="ghost" loading={busy === "resolve"} onClick={() => void send({ resolved: true }, "resolve")}>
                Mark fixed
              </Button>
            </div>
          )
        )}
      </div>
    </li>
  );
}
