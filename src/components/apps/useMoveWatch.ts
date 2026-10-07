"use client";
import * as React from "react";
import type { MoveJob } from "@/lib/app-move-types";
import { api } from "@/lib/client/api";
import { toast } from "@/components/ui/Toast";
import { markSeen, replay, wasSeen } from "./moveStream";

/**
 * Tells the person how a move ended when they weren't watching it: when an app stops being part
 * of a running move, fetch the move's result and toast it, unless the dialog showing it is open.
 * `moving` are the ids the server says a move involves (the original and the new copy).
 */
export function useMoveWatch(moving: string[], showing: string | null, onEnded?: () => void) {
  const before = React.useRef<Set<string>>(new Set(moving));
  const ended = React.useRef(onEnded);
  ended.current = onEnded;
  const showingRef = React.useRef(showing);
  showingRef.current = showing;
  const key = moving.slice().sort().join("|");

  React.useEffect(() => {
    const now = new Set(key ? key.split("|") : []);
    const gone = [...before.current].filter((id) => !now.has(id));
    before.current = now;
    if (!gone.length) return;
    ended.current?.();
    void (async () => {
      for (const id of gone) {
        const r = await api.get<{ job: MoveJob | null }>(`/api/apps/${encodeURIComponent(id)}/move?only=job`).catch(() => null);
        const job = r?.job;
        if (!job?.finishedAt || wasSeen(job)) continue;
        markSeen(job);
        if (showingRef.current === job.appId || showingRef.current === job.newId) continue;
        const result = replay(job.events).result;
        if (!result) continue;
        if (result.ok) toast.success(`${job.name} runs from Gluon now`, { description: result.message });
        else toast.error(`${job.name} didn't move`, { description: result.message });
      }
    })();
  }, [key]);
}
