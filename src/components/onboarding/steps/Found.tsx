"use client";
import * as React from "react";
import type { InventoryAddresses, InventoryApps, InventoryAttention, InventoryDrives } from "@/lib/onboarding";
import { useApi, type ApiError } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { listJoin } from "@/lib/format";
import { Actions, PartError, StepHead, useAdminPlan, useFlow } from "../flow";
import o from "../onboarding.module.css";

const URL = "/api/onboarding/inventory?part=";
// A first look, not a live view: read once, don't re-scan every time the window gets focus.
const ONCE = { revalidateOnFocus: false, revalidateOnReconnect: false } as const;

/**
 * Admin, step 1: what Gluon found on the server. Four readings (apps, drives, public addresses, what
 * needs you), each read on its own so a slow or failing one never holds up the rest.
 */
export function Found() {
  const plan = useAdminPlan();
  const { next } = useFlow();
  const apps = useApi<InventoryApps>(`${URL}apps`, ONCE);
  const drives = useApi<InventoryDrives>(`${URL}drives`, ONCE);
  const addresses = useApi<InventoryAddresses>(`${URL}addresses`, ONCE);
  const attention = useApi<InventoryAttention>(`${URL}attention`, ONCE);

  return (
    <>
      <StepHead title={<>Here&apos;s what Gluon found on {plan.serverName}</>}>
        <p>Gluon has looked around the server. It hasn&apos;t changed anything on it, and it only changes things when you ask.</p>
      </StepHead>

      <div className={o.readings}>
        <Reading label="Apps" q={apps} what="the apps" lines={3}>
          {(d) => <AppsReading d={d} />}
        </Reading>
        <Reading label="Drives" q={drives} what="the drives" lines={3}>
          {(d) => <DrivesReading d={d} />}
        </Reading>
        <Reading label="Public addresses" q={addresses} what="the public addresses" lines={2}>
          {(d) => <AddressesReading d={d} />}
        </Reading>
        <Reading label="Needs you" q={attention} what="what needs you" lines={2}>
          {(d) => <AttentionReading d={d} />}
        </Reading>
      </div>

      <Actions
        primary={
          <Button variant="primary" onClick={next}>
            Continue
          </Button>
        }
      />
    </>
  );
}

interface Query<T> {
  data?: T;
  error?: ApiError;
  mutate: () => unknown;
}

function Reading<T>({ label, q, what, lines, children }: { label: string; q: Query<T>; what: string; lines: number; children: (d: T) => React.ReactNode }) {
  const loading = !q.data && !q.error;
  return (
    <section className={o.reading} aria-busy={loading || undefined} aria-label={label}>
      <span className="label" aria-hidden>
        {label}
      </span>
      {q.data ? (
        <div className={`${o.readingBody} appear`}>{children(q.data)}</div>
      ) : q.error ? (
        <PartError
          message={q.error.message || `Gluon couldn't read ${what}.`}
          detail={typeof q.error.details?.detail === "string" ? q.error.details.detail : null}
          onRetry={() => void q.mutate()}
        />
      ) : (
        <div className={o.readingSkeleton}>
          <Skeleton width={72} height={28} />
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton key={i} width={`${88 - i * 18}%`} height={12} />
          ))}
        </div>
      )}
    </section>
  );
}

function Figure({ n, unit, mark }: { n: number | string; unit?: string; mark?: React.ReactNode }) {
  return (
    <p className={o.figure}>
      {mark}
      <b className="num">{n}</b>
      {unit && <span>{unit}</span>}
    </p>
  );
}

const SOURCE_WORDS: Record<keyof InventoryApps["sources"], string> = {
  umbrel: "from Umbrel",
  casaos: "from CasaOS",
  compose: "with Docker Compose",
  docker: "started with docker run",
};

function AppsReading({ d }: { d: InventoryApps }) {
  if (d.total === 0) {
    return (
      <>
        <Figure n="None" unit="yet" />
        <p className={o.detail}>
          {d.platform === "Docker"
            ? "Containers you start with Docker or Compose show up here by themselves."
            : `Apps you install from ${d.platform}, or start with Docker, show up here by themselves.`}
        </p>
      </>
    );
  }
  const parts = (Object.keys(SOURCE_WORDS) as (keyof InventoryApps["sources"])[]).filter((k) => d.sources[k] > 0).map((k) => `${d.sources[k]} ${SOURCE_WORDS[k]}`);
  const stopped = d.total - d.running;
  const more = d.total - d.sample.length;
  return (
    <>
      <Figure n={d.total} unit={d.total === 1 ? "app" : "apps"} />
      <ul className={o.icons} aria-label="Some of the apps">
        {d.sample.map((a) => (
          <li key={a.id} title={a.name}>
            <AppIcon src={a.icon} name={a.name} size={28} />
            <span className="sr-only">{a.name}</span>
          </li>
        ))}
        {more > 0 && (
          <li className={`${o.iconsMore} num`} aria-label={`and ${more} more`}>
            +{more}
          </li>
        )}
      </ul>
      <p className={o.detail}>
        {parts.length > 1 ? `${listJoin(parts)}.` : parts[0] ? `All ${parts[0]}.` : null} {d.running} running{stopped > 0 ? `, ${stopped} not running` : ""}.
      </p>
    </>
  );
}

function DrivesReading({ d }: { d: InventoryDrives }) {
  if (d.disks.length === 0) {
    return (
      <>
        <Figure n="None" unit="found" />
        <p className={o.detail}>Gluon couldn&apos;t see any drives. Storage explains what it could and couldn&apos;t read.</p>
      </>
    );
  }
  const shown = d.disks.slice(0, 3);
  return (
    <>
      <Figure n={d.disks.length} unit={d.disks.length === 1 ? "drive" : "drives"} />
      <ul className={o.rows}>
        {shown.map((x) => (
          <li key={x.id}>
            <span className={o.rowMain} title={x.title}>
              {x.title}
              {x.system && <span className={o.rowTag}> · system</span>}
            </span>
            <span className={o.rowSub} title={x.summary}>
              {x.summary}
            </span>
          </li>
        ))}
      </ul>
      {d.disks.length > shown.length && <p className={o.detail}>And {d.disks.length - shown.length} more in Storage.</p>}
    </>
  );
}

function AddressesReading({ d }: { d: InventoryAddresses }) {
  const self = d.gluon ? (
    <p className={o.detail}>
      Gluon itself is reachable at <span className="mono">{d.gluon}</span>.
    </p>
  ) : null;
  if (!d.configured) {
    return (
      <>
        <Figure n="None" unit="set up" />
        <p className={o.detail}>Gluon didn&apos;t find a proxy it can manage, so it isn&apos;t publishing anything. Network can set one up later.</p>
        {self}
      </>
    );
  }
  if (d.count === 0) {
    return (
      <>
        <Figure n="None" unit="yet" />
        <p className={o.detail}>Nothing is published to the internet through Gluon&apos;s proxy.</p>
        {self}
      </>
    );
  }
  return (
    <>
      <Figure n={d.count} unit={d.count === 1 ? "address" : "addresses"} />
      <ul className={o.rows}>
        {d.sample.slice(0, 3).map((r) => (
          <li key={r.url}>
            <span className={`${o.rowMain} mono`} title={r.url}>
              {r.url}
            </span>
          </li>
        ))}
      </ul>
      {self}
    </>
  );
}

function AttentionReading({ d }: { d: InventoryAttention }) {
  const total = d.fault + d.attention;
  if (total === 0) {
    return (
      <>
        <Figure n={0} mark={<StateLine state="running" size={18} />} />
        <p className={o.detail}>Nothing needs you right now. Gluon keeps checking from here on.</p>
      </>
    );
  }
  return (
    <>
      <Figure n={total} unit={total === 1 ? "thing" : "things"} mark={<StateLine state="attention" size={18} />} />
      <ul className={o.rows}>
        {d.top.map((f) => (
          <li key={f.id} className={o.rowState}>
            <StateLine state={f.severity === "fault" ? "unhealthy" : "attention"} size={12} />
            <span className={o.rowMain} title={f.title}>
              {f.title}
            </span>
          </li>
        ))}
      </ul>
      <p className={o.detail}>{total > d.top.length ? `And ${total - d.top.length} more. ` : ""}Status has each one with its fix.</p>
    </>
  );
}
