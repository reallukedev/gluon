"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import type { RoutesConfigT, RoutesHistoryEntry, RoutesResponse } from "@/lib/network-types";
import { api, useApi, ApiError } from "@/lib/client/api";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { useFormat } from "@/components/PrefsProvider";
import s from "./network.module.css";

const CodeEditor = dynamic(() => import("@/components/code/CodeEditor").then((m) => m.CodeEditor), { ssr: false, loading: () => <Skeleton height={380} radius={10} /> });

const asText = (c: Pick<RoutesConfigT, "fallback" | "routes">) => JSON.stringify({ fallback: c.fallback, routes: c.routes }, null, 2) + "\n";

function changeCount(cur: RoutesConfigT, snap: RoutesConfigT): string {
  const a = new Map(cur.routes.map((r) => [r.id, JSON.stringify(r)]));
  const b = new Map(snap.routes.map((r) => [r.id, JSON.stringify(r)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, v] of b) {
    if (!a.has(id)) added++;
    else if (a.get(id) !== v) changed++;
  }
  for (const id of a.keys()) if (!b.has(id)) removed++;
  const parts = [added && `brings back ${added}`, removed && `removes ${removed}`, changed && `changes ${changed}`].filter(Boolean);
  if (JSON.stringify(cur.fallback) !== JSON.stringify(snap.fallback)) parts.push("changes “everything else”");
  return parts.length ? `Restoring ${parts.join(", ")} address${added + removed + changed === 1 ? "" : "es"}.` : "Same as now.";
}

export function HistoryDialog({ open, onOpenChange, data, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; data: RoutesResponse; onRestored: () => void }) {
  const fmt = useFormat();
  const list = useApi<{ entries: RoutesHistoryEntry[] }>(open ? "/api/network/routes/history" : null);
  const [sel, setSel] = React.useState<string | null>(null);
  const snap = useApi<{ id: string; config: RoutesConfigT }>(open && sel ? `/api/network/routes/history/${encodeURIComponent(sel)}` : null);
  const [confirm, confirmNode] = useConfirm();

  React.useEffect(() => {
    if (open && !sel && list.data?.entries[0]) setSel(list.data.entries.find((e) => e.hasRoutes)?.id ?? null);
  }, [open, sel, list.data]);

  const entry = list.data?.entries.find((e) => e.id === sel);

  function restore() {
    if (!entry || !snap.data) return;
    confirm({
      title: "Restore this version?",
      description: `Saved ${fmt.dateTime(Date.parse(entry.time))}${entry.reason ? `: ${entry.reason}` : ""}.`,
      consequences: [changeCount(data.config, snap.data.config), "Caddy switches over without dropping connections.", "The current version is kept in History, so you can come back to it."],
      confirmLabel: "Restore",
      variant: "primary",
      onConfirm: async () => {
        try {
          await api.post("/api/network/routes/history", { id: entry.id, rev: data.rev });
          toast.success("Restored. Caddy is using that version now.");
          onRestored();
          onOpenChange(false);
        } catch (e) {
          if (e instanceof ApiError && e.code === "stale") {
            onRestored();
            throw new Error("The addresses changed while you were looking. They've been reloaded; try again.");
          }
          throw e;
        }
      },
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="History"
        description="A copy is kept before every save (the last 40). Pick one to see how it differs from now."
        size="xwide"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button variant="primary" disabled={!snap.data || !entry?.hasRoutes} onClick={restore}>
              Restore this version
            </Button>
          </>
        }
      >
        {list.error ? (
          <Notice tone="fault" title="Couldn't load the history">{list.error.message}</Notice>
        ) : !list.data ? (
          <Skeleton height={300} radius={10} />
        ) : !list.data.entries.length ? (
          <Empty title="No earlier versions yet">Every time you save an address, the previous version is kept here.</Empty>
        ) : (
          <div className={s.history}>
            <ul className={s.historyList} role="listbox" aria-label="Saved versions">
              {list.data.entries.map((e) => (
                <li key={e.id}>
                  <button type="button" role="option" aria-selected={sel === e.id} className={s.historyItem} data-on={sel === e.id ? "" : undefined} disabled={!e.hasRoutes} onClick={() => setSel(e.id)}>
                    <Time ts={Date.parse(e.time)} kind="dateTime" className="num" />
                    <span className={s.historyReason}>{e.reason || (e.hasRoutes ? "Saved" : "No routes file in this copy")}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className={s.historyPreview}>
              {!sel ? (
                <p className={s.faint}>Pick a version on the left.</p>
              ) : snap.error ? (
                <Notice tone="fault" title="Couldn't open that version">{snap.error.message}</Notice>
              ) : !snap.data ? (
                <Skeleton height={380} radius={10} />
              ) : (
                <>
                  <p className={s.historyChange}>{changeCount(data.config, snap.data.config)}</p>
                  <CodeEditor key={sel} value={asText(snap.data.config)} original={asText(data.config)} language="json" readOnly height={420} label="Differences between this version and now" />
                  <p className={s.faint}>Highlighted lines are what restoring would change.</p>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
      {confirmNode}
    </>
  );
}
