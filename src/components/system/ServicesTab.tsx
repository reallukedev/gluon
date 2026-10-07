"use client";
import * as React from "react";
import type { SWRResponse } from "swr";
import { MoreHoriz, Search, Play, Square, Refresh, Journal, RefreshCircle, Check, Prohibition } from "iconoir-react";
import type { ServiceAction, ServiceInfo } from "@/lib/system-types";
import type { ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Segmented } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { ACTION_LABEL, availableActions, bootLabel, serviceLine, useServiceActions } from "./serviceActions";
import { ServiceDialog } from "./ServiceDialog";
import s from "./system.module.css";

type Filter = "all" | "running" | "stopped" | "failed";

const ICON: Record<ServiceAction, React.ReactNode> = {
  start: <Play />,
  stop: <Square />,
  restart: <Refresh />,
  reload: <RefreshCircle />,
  enable: <Check />,
  disable: <Prohibition />,
};

export function ServicesTab({ list, initialUnit }: { list: SWRResponse<{ services: ServiceInfo[] }, ApiError>; initialUnit: string | null }) {
  const fmt = useFormat();
  const { data, error, mutate } = list;
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [unit, setUnit] = React.useState<string | null>(initialUnit);
  const refresh = React.useCallback(() => void mutate(), [mutate]);
  const { act, busy, confirmNode } = useServiceActions(refresh, (u) => openUnit(u));

  function openUnit(u: string | null) {
    setUnit(u);
    // Keep the URL shareable (⌘K and Needs you link here) without re-rendering the page on the server.
    window.history.replaceState(null, "", u ? `/system?tab=services&unit=${encodeURIComponent(u)}` : "/system?tab=services");
  }

  if (!data) {
    if (error) {
      return (
        <Notice tone="fault" title="Couldn't list the services" action={<Button onClick={refresh}>Try again</Button>}>
          {error.message}
        </Notice>
      );
    }
    return <ServicesSkeleton />;
  }

  const services = data.services.filter((x) => x.load !== "not-found" || x.active === "failed");
  const isRunning = (x: ServiceInfo) => x.active === "active" && x.sub !== "exited";
  const counts = {
    running: services.filter(isRunning).length,
    failed: services.filter((x) => x.active === "failed").length,
  };
  const term = q.trim().toLowerCase();
  const rows = services
    .filter((x) => {
      if (filter === "running") return isRunning(x);
      if (filter === "failed") return x.active === "failed";
      if (filter === "stopped") return !isRunning(x) && x.active !== "failed";
      return true;
    })
    .filter((x) => !term || x.unit.toLowerCase().includes(term) || x.name.toLowerCase().includes(term) || x.description.toLowerCase().includes(term))
    .sort(
      (a, b) =>
        Number(b.active === "failed") - Number(a.active === "failed") || Number(b.important) - Number(a.important) || Number(isRunning(b)) - Number(isRunning(a)) || a.name.localeCompare(b.name),
    );

  const current = unit ? (data.services.find((x) => x.unit === unit) ?? null) : null;

  return (
    <div className={s.stack}>
      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or description" aria-label="Filter services" spellCheck={false} />
        </label>
        <Segmented
          aria-label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "running", label: `Running ${counts.running}` },
            { value: "stopped", label: "Stopped" },
            {
              value: "failed",
              label: counts.failed ? `Failed ${counts.failed}` : "Failed",
            },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <Empty title={term ? `Nothing matches “${q}”` : filter === "failed" ? "No failed services" : "Nothing here"}>
          {term
            ? "Try part of the service's name, like smbd or docker, or words from its description."
            : filter === "failed"
              ? "Every service that should be running is running."
              : "Services are the programs systemd starts in the background: file sharing, remote login, Docker and so on."}
        </Empty>
      ) : (
        <div className={s.table} role="table" aria-label="Services">
          <div className={s.svcHead} role="row">
            <span role="columnheader">Service</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Starts</span>
            <span role="columnheader" className={s.num}>
              Memory
            </span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {rows.map((x) => {
            const line = serviceLine(x);
            const actions = availableActions(x);
            const items: MenuEntry[] = [
              ...actions.map((a) => ({
                label: ACTION_LABEL[a],
                icon: ICON[a],
                danger: a === "stop" && x.important,
                onSelect: () => act(x, a),
              })),
              ...(actions.length ? ["separator" as const] : []),
              {
                label: "Details and log",
                icon: <Journal />,
                onSelect: () => openUnit(x.unit),
              },
              ...(x.blocked.length >= 3
                ? [
                    {
                      label: "Gluon doesn't stop or restart this one",
                      disabled: true,
                    },
                  ]
                : []),
            ];
            return (
              <div
                key={x.unit}
                role="row"
                className={s.svcRow}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button,[role=menu]")) return;
                  openUnit(x.unit);
                }}
              >
                <span role="cell" className={s.svcCell}>
                  <button type="button" className={s.svcName} onClick={() => openUnit(x.unit)} title={x.name}>
                    {x.name}
                  </button>
                  <span className={`${s.sub} ${s.truncate}`} title={`${x.unit}${x.about ? ` · ${x.about}` : x.name !== x.description ? ` · ${x.description}` : ""}`}>
                    <span className="mono">{x.unit.replace(/\.service$/, "")}</span>
                    {x.about ? ` · ${x.about}` : x.name !== x.description ? ` · ${x.description}` : ""}
                  </span>
                </span>
                <span role="cell" className={s.svcState}>
                  <StateLine state={line.state} label={line.label} />
                </span>
                <span role="cell" className={s.svcBoot}>
                  {bootLabel(x.enabled)}
                </span>
                <span role="cell" className={`${s.num} num`}>
                  {x.memory !== null && x.memory > 0 ? fmt.bytes(x.memory) : <span className={s.faint}>None</span>}
                </span>
                <span role="cell" className={s.actions}>
                  <IconButton label={`Log for ${x.name}`} size="sm" onClick={() => openUnit(x.unit)}>
                    <Journal />
                  </IconButton>
                  <Menu
                    trigger={
                      <IconButton label={`${x.name} actions`} size="sm" loading={busy === x.unit}>
                        <MoreHoriz />
                      </IconButton>
                    }
                    items={items}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}

      <ServiceDialog unit={unit} summary={current} onClose={() => openUnit(null)} act={act} busy={busy} onChanged={refresh} />
      {confirmNode}
    </div>
  );
}

function ServicesSkeleton() {
  return (
    <div className={s.stack} aria-busy>
      <Skeleton height={34} width={380} radius={7} />
      <div className={s.table}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={s.svcRow} style={{ cursor: "default" }}>
            <span className={s.svcCell}>
              <Skeleton height={15} width={`${45 + ((i * 19) % 40)}%`} />
              <Skeleton height={12} width="35%" />
            </span>
            <Skeleton height={14} width={90} />
            <Skeleton height={14} width={60} />
            <Skeleton height={14} width={50} />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
