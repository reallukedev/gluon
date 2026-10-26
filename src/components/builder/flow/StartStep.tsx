"use client";
import * as React from "react";
import { OpenNewWindow } from "iconoir-react";
import type { BuilderTarget, CustomAppDetail } from "@/lib/builder-types";
import type { RouteWarning, RoutesResponse } from "@/lib/network-types";
import { ApiError, api } from "@/lib/client/api";
import { Panel, Notice } from "@/components/ui/Surface";
import { Button, LinkButton } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { THIS_SERVER, newRouteId, saveRoutes, suggestLabel } from "@/components/network/shared";
import { addressRoute, labelError, routesWith } from "@/lib/builder/address";
import { JobProgress } from "../JobProgress";
import { runtimeLine } from "../Issues";
import { linkHost } from "../state";
import type { useJob } from "../useJob";
import type { AddressState } from "./address";
import { FlowNav } from "./FlowFrame";
import s from "../builder.module.css";
import f from "./flow.module.css";

type Job = ReturnType<typeof useJob>;

/** The run itself, streamed, then a plain answer: it's running (open it), or what went wrong. */
export function StartStep({ detail: d, job, target, address, onRetry, onBackToReview }: { detail: CustomAppDetail; job: Job; target: BuilderTarget; address: AddressState; onRetry: () => void; onBackToReview: () => void }) {
  const { view, running, startError, follow } = job;
  const name = d.spec.details.name.trim() || "The app";
  // After a reload (or a start from another tab) the polled job stands in for the stream.
  React.useEffect(() => {
    if (!running && d.job) follow();
  }, [running, d.job?.events.length, d.job?.finishedAt, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const ok = view?.result?.ok === true || (!view && !d.job && d.status === "published");
  const failed = view?.result?.ok === false;
  const label = target === "umbrel" ? `Installing ${name}` : `Starting ${name}`;

  if (startError) {
    return (
      <div className={f.stack}>
        <Notice tone="fault" title="It didn't start">
          {startError}
        </Notice>
        <FlowNav back={{ label: "Back to review", onClick: onBackToReview }}>
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </FlowNav>
      </div>
    );
  }

  return (
    <div className={f.stack}>
      {view && (
        <Panel title={ok ? (target === "umbrel" ? `${name} is in Umbrel` : `${name} is running`) : failed ? "It didn't finish" : label}>
          <JobProgress view={view} stages={view.stages} running={!view.result} openOutput={failed && !view.result?.detail?.length} label={label} />
        </Panel>
      )}
      {ok && <Running detail={d} address={address} />}
      {failed && (
        <FlowNav back={{ label: "Back to review", onClick: onBackToReview }}>
          <LinkButton href={`/apps/custom/${d.id}`}>Fix it in the builder</LinkButton>
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </FlowNav>
      )}
    </div>
  );
}

type AddressResult = { state: "idle" | "saving" } | { state: "saved"; url: string; warnings: RouteWarning[] } | { state: "failed"; message: string };

/** It's running: open it, find it, and (when chosen) its new public address with any warnings. */
function Running({ detail: d, address: { choice, update } }: { detail: CustomAppDetail; address: AddressState }) {
  const name = d.spec.details.name.trim() || "the app";
  const w = d.spec.web;
  const url = d.runtime?.url ?? (w.service && w.port ? `http://${linkHost(d)}:${w.port}${w.path || ""}` : null);
  const rt = d.runtime ? runtimeLine(d.status, d.runtime, null) : { line: "running" as const, label: "Running" };
  const [addr, setAddr] = React.useState<AddressResult>({ state: "idle" });
  const tried = React.useRef(false);
  const port = w.port ?? w.containerPort;

  const publish = React.useCallback(async () => {
    if (!port) return;
    setAddr({ state: "saving" });
    const label = (choice.label || suggestLabel(name)).toLowerCase();
    try {
      for (let attempt = 0; ; attempt++) {
        const fresh = await api.get<RoutesResponse>("/api/network/routes");
        const route = addressRoute(fresh.config, { id: newRouteId(label), label, name: d.spec.details.name, appId: d.runtime?.appsId ?? d.appId, backendHost: THIS_SERVER, port });
        const { routes, already } = routesWith(fresh.config, route);
        if (already) {
          update({ saved: { host: route.host } });
          return setAddr({ state: "saved", url: `https://${route.host}`, warnings: [] });
        }
        const err = labelError(label, fresh.config);
        if (err) return setAddr({ state: "failed", message: err });
        try {
          const res = await saveRoutes(fresh.rev, routes);
          update({ saved: { host: route.host } });
          return setAddr({ state: "saved", url: res.urls[route.id] ?? `https://${route.host}`, warnings: res.warnings.filter((x) => x.routeId === route.id) });
        } catch (e) {
          // Someone else saved addresses in between: read them again and add this one once more.
          if (e instanceof ApiError && e.code === "stale" && attempt === 0) continue;
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return setAddr({ state: "failed", message: "Publishing the address needs your password again. Try again when you're ready." });
      setAddr({ state: "failed", message: e instanceof Error ? e.message : "The address wasn't added." });
    }
  }, [choice.label, name, d.spec.details.name, d.runtime?.appsId, d.appId, port, update]);

  React.useEffect(() => {
    if (choice.on && !choice.saved && !tried.current) {
      tried.current = true;
      void publish();
    } else if (choice.saved && addr.state === "idle") setAddr({ state: "saved", url: `https://${choice.saved.host}`, warnings: [] });
  }, [choice.on, choice.saved, publish, addr.state]);

  return (
    <Panel title="Open it">
      <div className={f.running}>
        <div className={f.runningState}>
          <StateLine state={rt.line} label={rt.label} />
          {url && <span className="mono">{url.replace(/^https?:\/\//, "")}</span>}
        </div>
        {choice.on && (
          <div className={f.addressResult} aria-live="polite">
            {addr.state === "saving" && <StateLine state="starting" size={12} label="Adding its public address" />}
            {addr.state === "saved" && (
              <>
                <StateLine state="running" size={12} label="On the internet at" />
                <a className={`${s.link} mono`} href={addr.url} target="_blank" rel="noopener noreferrer">
                  {addr.url.replace(/^https:\/\//, "")}
                </a>
              </>
            )}
            {addr.state === "saved" && addr.warnings.length > 0 && (
              <Notice tone="attention" title={addr.warnings.length === 1 ? "One thing to check" : "Things to check"}>
                {addr.warnings.map((x) => x.message).join(" ")}
              </Notice>
            )}
            {addr.state === "failed" && (
              <Notice tone="fault" title="The public address wasn't added" action={<Button size="sm" onClick={() => void publish()}>Try again</Button>}>
                {addr.message} The app itself is running; you can also add the address on the Network page.
              </Notice>
            )}
          </div>
        )}
        <div className={f.runningActions}>
          {url && (
            <Button variant="primary" icon={<OpenNewWindow />} onClick={() => window.open(url, "_blank", "noopener")}>
              Open {name}
            </Button>
          )}
          {d.runtime?.appsId && (
            <LinkButton href={`/apps/${encodeURIComponent(d.runtime.appsId)}`}>Show in Apps</LinkButton>
          )}
          <LinkButton href={`/apps/custom/${d.id}`} variant="ghost">
            Open in the full builder
          </LinkButton>
          {/* A full load: this page keeps its state across same-route navigations. */}
          <Button variant="ghost" onClick={() => window.location.assign("/apps/new")}>
            Make another app
          </Button>
        </div>
      </div>
    </Panel>
  );
}
