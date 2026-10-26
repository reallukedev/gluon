"use client";
import * as React from "react";
import type { ServiceAction, ServiceDetail, ServiceInfo } from "@/lib/system-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { DefinitionList, Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Button } from "@/components/ui/Button";
import { Time } from "@/components/ui/Time";
import { ACTION_LABEL, availableActions, bootLabel, serviceLine } from "./serviceActions";
import { ServiceJournal } from "./ServiceJournal";
import s from "./system.module.css";

/** A service's details and live log, opened from the list (or ⌘K / a Needs you link via ?unit=). */
export function ServiceDialog({
  unit,
  summary,
  onClose,
  act,
  busy,
  onChanged,
}: {
  unit: string | null;
  summary: ServiceInfo | null;
  onClose: () => void;
  act: (svc: ServiceInfo, action: ServiceAction) => void;
  busy: string | null;
  onChanged: () => void;
}) {
  const fmt = useFormat();
  const { data, error, mutate } = useApi<ServiceDetail>(unit ? `/api/system/services/${encodeURIComponent(unit)}` : null, { refresh: 5000 });
  const svc: ServiceInfo | null = data ?? summary;
  const line = svc ? serviceLine(svc) : null;
  const actions = svc ? availableActions(svc) : [];

  const run = (a: ServiceAction) => {
    if (!svc) return;
    act(svc, a);
    // The list refreshes through onChanged; refresh the detail a moment later too.
    setTimeout(() => void mutate(), 1200);
    onChanged();
  };

  const items: [React.ReactNode, React.ReactNode][] = [];
  if (svc) {
    items.push([
      "Service",
      <span key="u" className="mono">
        {svc.unit}
      </span>,
    ]);
    if (svc.about) items.push(["What it does", svc.about]);
    if (svc.description && svc.description !== svc.name) items.push([svc.about ? "Its own description" : "What it is", svc.description]);
    if (svc.active === "active" && svc.activeSince) items.push([svc.sub === "exited" ? "Finished" : "Running since", <Time key="since" ts={svc.activeSince} kind="dateTime" />]);
    else if (svc.inactiveSince) items.push([svc.active === "failed" ? "Failed" : "Stopped", <Time key="stop" ts={svc.inactiveSince} kind="dateTime" />]);
    items.push(["Starts", bootLabel(svc.enabled)]);
    if (svc.mainPid)
      items.push([
        "Process",
        <span key="pid" className="mono num">
          {svc.mainPid}
        </span>,
      ]);
    if (svc.memory)
      items.push([
        "Memory",
        <span key="mem" className="num">
          {fmt.bytes(svc.memory)}
        </span>,
      ]);
    if (svc.restarts)
      items.push([
        "Restarted",
        <span key="r" className="num">
          {fmt.plural(svc.restarts, "time")} since it was started
        </span>,
      ]);
    if (data?.execStart)
      items.push([
        "Command",
        <code key="cmd" className={`mono ${s.wrapAnywhere}`}>
          {data.execStart}
        </code>,
      ]);
    if (data?.user)
      items.push([
        "Runs as",
        <span key="user" className="mono">
          {data.user}
        </span>,
      ]);
    if (data?.triggeredBy.length)
      items.push([
        "Started by",
        <span key="tb" className="mono">
          {data.triggeredBy.join(", ")}
        </span>,
      ]);
    if (svc.path)
      items.push([
        "Definition",
        <span key="p" className={`mono ${s.wrapAnywhere}`}>
          {svc.path}
        </span>,
      ]);
  }

  return (
    <Dialog
      open={!!unit}
      onOpenChange={(o) => !o && onClose()}
      size="xwide"
      title={svc?.name ?? unit ?? "Service"}
      description={
        svc && line ? (
          <span className={s.dialogState}>
            <StateLine state={line.state} label={data?.statusText ?? line.label} />
          </span>
        ) : undefined
      }
    >
      {error && !svc ? (
        <Notice tone="fault" title="Couldn't load this service">
          {error.message}
        </Notice>
      ) : !svc ? (
        <div className={s.skelRows}>
          <Skeleton height={16} width="40%" />
          <Skeleton height={16} width="60%" />
          <Skeleton height={220} radius={10} />
        </div>
      ) : (
        <div className={s.dialogBody}>
          {(actions.length > 0 || svc.blocked.length > 0) && (
            <div className={s.dialogActions}>
              {actions.map((a) => (
                <Button key={a} size="sm" variant={a === "start" ? "primary" : "secondary"} loading={busy === svc.unit} onClick={() => run(a)}>
                  {ACTION_LABEL[a]}
                </Button>
              ))}
              {svc.blocked.includes("stop") && <span className={s.sub}>The system needs this to keep running, so Gluon won't stop or restart it.</span>}
            </div>
          )}
          <DefinitionList items={items} />
          {unit && <ServiceJournal unit={unit} />}
        </div>
      )}
    </Dialog>
  );
}
