"use client";
import * as React from "react";
import type { McChangeResult, McHistoryEntry } from "@/lib/games-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Empty, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { GAMES_URL } from "./model";
import s from "../games.module.css";

const change = (summary: string) => {
  const t = summary.replace(/^Minecraft: /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** mc-router's routes file as it was before each change Gluon made, newest first, each one a click from coming back. */
export function RoutesHistory({ open, onOpenChange, file, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; file: string | null; onRestored: (r: McChangeResult) => void }) {
  const { data, error, mutate } = useApi<{ entries: McHistoryEntry[] }>(open ? `${GAMES_URL}/minecraft/history` : null);
  const [busy, setBusy] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  async function restore(id: number) {
    setBusy(id);
    setErr(null);
    try {
      const r = await api.post<McChangeResult>(`${GAMES_URL}/minecraft/history`, { id });
      onRestored(r);
      void mutate();
      onOpenChange(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => busy === null && onOpenChange(o)}
      title="Earlier versions"
      description={file ? <>Each change Gluon made to <span className="mono">{file}</span>, newest first. Put back the file as it was before any of them.</> : undefined}
      footerStart={err ? <span className={s.formError}>{err}</span> : undefined}
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      {!data ? (
        error ? (
          <p className={s.formError}>{error.message}</p>
        ) : (
          <div className={s.form}>
            <Skeleton height={44} radius={8} />
            <Skeleton height={44} radius={8} />
          </div>
        )
      ) : data.entries.length === 0 ? (
        <Empty title="Nothing kept yet">Each time Gluon changes the file, the version before goes here.</Empty>
      ) : (
        <ul className={s.history}>
          {data.entries.map((e) => (
            <li key={e.id} className={s.historyRow}>
              <span className={s.historyText}>
                <span className={s.historyWhat}>{change(e.summary)}</span>
                <span className={s.sub}>
                  <Time ts={e.at} />
                  {e.username ? `, by ${e.username}` : ""} · the version before had {e.mappings === 1 ? "1 address" : `${e.mappings} addresses`}
                </span>
              </span>
              <Button size="sm" loading={busy === e.id} disabled={busy !== null} onClick={() => void restore(e.id)}>
                Put back
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
