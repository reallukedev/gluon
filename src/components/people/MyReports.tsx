"use client";
import * as React from "react";
import type { ProblemReport } from "@/lib/people-types";
import { api, useApi } from "@/lib/client/api";
import { Panel } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Time } from "@/components/ui/Time";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { ReportSteps, reportStage } from "./bits";
import s from "./people.module.css";

/** SWR key: `mutate(MY_REPORTS_URL)` after sending a report to show it straight away. */
export const MY_REPORTS_URL = "/api/household/reports?status=all&limit=20";

/** Fixed reports stay in the list for a few days so the "it's fixed" news gets seen, then drop off. */
const KEEP_FIXED_MS = 7 * 86_400_000;

/**
 * "Your reports" for household members: what they reported, where it's got to (sent → seen → fixed)
 * and any reply. Renders nothing until they've reported something, so a calm Status page stays calm.
 */
export function MyReports() {
  const { data, mutate } = useApi<ProblemReport[]>(MY_REPORTS_URL, { refresh: 60_000 });
  const [confirm, confirmNode] = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    const id = typeof window !== "undefined" ? window.location.hash.match(/^#report-(.+)$/)?.[1] : undefined;
    if (id && data?.some((r) => r.id === decodeURIComponent(id))) document.getElementById(`report-${decodeURIComponent(id)}`)?.scrollIntoView({ block: "center" });
  }, [data]);

  const now = Date.now();
  const items = (data ?? []).filter((r) => !r.resolvedAt || now - r.resolvedAt < KEEP_FIXED_MS);
  if (items.length === 0) return null;

  const withdraw = (r: ProblemReport) =>
    confirm({
      title: "Take back this report?",
      consequences: ["It's removed, and nobody needs to look at it any more."],
      confirmLabel: "Take it back",
      cancelLabel: "Keep it",
      variant: "primary",
      onConfirm: async () => {
        setBusy(r.id);
        try {
          await api.del(`/api/household/reports/${encodeURIComponent(r.id)}`);
          toast.success("Report taken back", { description: "Glad it's working." });
          void mutate();
        } finally {
          setBusy(null);
        }
      },
    });

  const open = items.filter((r) => !r.resolvedAt).length;
  return (
    <div className={s.mineWrap}>
      <Panel title="Your reports" meta={open ? <span className="num">{open} open</span> : <span>All fixed</span>} flush>
        <ul className={s.mine} role="list">
          {items.map((r) => {
            const stage = reportStage(r);
            const by = r.acknowledgedByName ?? r.repliedByName;
            const line =
              stage === "fixed"
                ? `Fixed${r.resolvedByName ? ` by ${r.resolvedByName}` : ""}. Thanks for letting us know.`
                : stage === "seen"
                  ? `${by ?? "The admin"} has seen it and is looking into it.`
                  : "Sent. The admin has been told and you'll see their reply here.";
            return (
              <li key={r.id} id={`report-${r.id}`} className={s.mineItem} data-stage={stage}>
                <div className={s.mineHead}>
                  <span className={s.mineWhat}>
                    {r.appName ?? "Something else"} · <Time ts={r.createdAt} />
                  </span>
                  <ReportSteps stage={stage} />
                </div>
                <p className={s.reportMsg}>{r.message}</p>
                <p className={s.mineLine}>{line}</p>
                {r.reply && (
                  <div className={s.reply}>
                    <span className={s.replyHead}>
                      {r.repliedByName ?? "The admin"} replied {r.repliedAt ? <Time ts={r.repliedAt} /> : null}
                    </span>
                    {r.reply}
                  </div>
                )}
                {stage !== "fixed" && !r.reply && (
                  <div>
                    <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => withdraw(r)}>
                      It's working now, take it back
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>
      {confirmNode}
    </div>
  );
}
