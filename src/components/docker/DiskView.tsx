"use client";
import * as React from "react";
import Link from "next/link";
import { Refresh } from "iconoir-react";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { SegmentBar } from "@/components/ui/SegmentBar";
import type { CleanupKind, DockerDisk } from "@/lib/docker-types";
import { AppsSectionTabs } from "./AppsSectionTabs";
import { CleanupDialog } from "./CleanupDialog";
import { LoadError } from "./shared";
import s from "./docker.module.css";

interface Kind {
  key: CleanupKind;
  name: string;
  href?: string;
  what: string;
  bytes: number;
  free: number;
  freeWords: string;
  action: string;
  exact: boolean;
}

/**
 * What Docker keeps on disk and what could go: one bar of the disk Docker lives on, then one row
 * per kind of thing with its one cleanup, each previewed before anything is removed.
 */
export function DiskView() {
  const fmt = useFormat();
  const [fresh, setFresh] = React.useState(0);
  const { data, error, isValidating, mutate } = useApi<DockerDisk>(`/api/docker/disk${fresh ? "?fresh=1" : ""}`, { refresh: 60_000, revalidateOnFocus: false });
  const [cleanup, setCleanup] = React.useState<CleanupKind | null>(null);

  const kinds: Kind[] = data
    ? [
        {
          key: "images",
          name: "Images",
          href: "/apps/images",
          what: `${fmt.plural(data.images.count, "image")}, ${data.images.unused} not used by any container`,
          bytes: data.images.bytes,
          free: data.images.unusedBytes,
          freeWords: "at least",
          action: "Remove unused images",
          exact: false,
        },
        {
          key: "buildcache",
          name: "Build cache",
          what: data.buildCache.count ? `${fmt.plural(data.buildCache.count, "step")} of earlier builds, kept to make rebuilds faster` : "Nothing kept from builds",
          bytes: data.buildCache.bytes,
          free: data.buildCache.reclaimable,
          freeWords: "about",
          action: "Clear the build cache",
          exact: false,
        },
        {
          key: "volumes",
          name: "Volumes",
          href: "/apps/volumes",
          what: `${fmt.plural(data.volumes.count, "volume")}, ${data.volumes.unused} not used by any container`,
          bytes: data.volumes.bytes,
          free: data.volumes.unusedBytes,
          freeWords: "up to",
          action: "Remove unused volumes",
          exact: true,
        },
        {
          key: "containers",
          name: "Containers",
          href: "/apps",
          what: `Changes ${fmt.plural(data.containers.count, "container")} made to their own files; ${data.containers.stopped} stopped`,
          bytes: data.containers.bytes,
          free: data.containers.stoppedBytes,
          freeWords: "up to",
          action: "Remove stopped containers",
          exact: true,
        },
      ]
    : [];
  const canFree = kinds.reduce((a, k) => a + k.free, 0);
  const pctFull = data?.fs ? 1 - data.fs.free / data.fs.size : null;
  const tight = pctFull !== null && pctFull >= 0.9;

  const summary = !data ? (
    error ? "Gluon couldn't ask Docker how much space it uses." : "Measuring what Docker keeps on disk. This can take a moment."
  ) : (
    <>
      <b>
        Docker uses <span className="num">{fmt.bytes(data.total)}</span>
        {data.fs ? (
          <>
            {" "}
            of the disk at <span className="mono">{data.fs.mount}</span>, which has <span className="num">{fmt.bytes(data.fs.free)}</span> free.
          </>
        ) : (
          "."
        )}
      </b>{" "}
      {tight ? <b>That disk is {Math.round(pctFull! * 100)}% full. </b> : null}
      {canFree > 0 ? (
        <>
          About <span className="num">{fmt.bytes(canFree)}</span> of it could go.
        </>
      ) : (
        "Nothing is left over to clean up."
      )}
    </>
  );

  const other = data?.fs ? Math.max(0, data.fs.size - data.fs.free - data.total) : 0;

  return (
    <Page>
      <AppsSectionTabs current="disk" />
      <PageHeader
        title="Disk use"
        summary={summary}
        actions={
          <Button
            icon={<Refresh />}
            loading={isValidating && !!data}
            onClick={() => {
              setFresh((n) => n + 1);
              void mutate();
            }}
          >
            Measure again
          </Button>
        }
      />
      {error && !data ? (
        <LoadError error={error} what="Docker's disk use" onRetry={() => void mutate()} retrying={isValidating} />
      ) : (
        <div className={s.diskGrid}>
          <Panel title={data?.fs ? "The disk Docker uses" : "What Docker keeps"} meta={data?.root ? <span className="mono">{data.root}</span> : undefined}>
            {!data ? (
              <div aria-busy="true" aria-label="Measuring">
                <Skeleton width={160} height={28} />
                <div className={s.meter}>
                  <Skeleton height={12} />
                </div>
                <div className={s.legend}>
                  {[70, 90, 60, 80].map((w, i) => (
                    <Skeleton key={i} width={w} height={10} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="appear">
                <div className={s.meterHead}>
                  <span className={s.figure}>
                    {fmt.bytes(data.total)}
                    <small>used by Docker</small>
                  </span>
                  {data.fs && (
                    <span className={s.fsLine}>
                      <span className="num">{fmt.bytes(data.fs.free)}</span> free of <span className="num">{fmt.bytes(data.fs.size)}</span>
                      {data.fs.mount !== data.root && (
                        <>
                          {" "}
                          on <span className="mono">{data.fs.mount}</span>
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className={s.meter}>
                  <SegmentBar
                    label="The disk Docker uses"
                    total={data.fs?.size}
                    format={(v) => fmt.bytes(v)}
                    restLabel={data.fs ? "Free" : undefined}
                    summary={data.fs ? `${fmt.bytes(data.fs.size - data.fs.free)} of ${fmt.bytes(data.fs.size)} in use` : `${fmt.bytes(data.total)} in all`}
                    segments={[
                      { key: "images", label: "Images", value: data.images.bytes, meta: fmt.plural(data.images.count, "image") },
                      { key: "buildcache", label: "Build cache", value: data.buildCache.bytes },
                      { key: "volumes", label: "Volumes", value: data.volumes.bytes, meta: fmt.plural(data.volumes.count, "volume") },
                      { key: "containers", label: "Containers", value: data.containers.bytes, meta: fmt.plural(data.containers.count, "container") },
                      ...(other > 0 ? [{ key: "other", label: "Everything else on this disk", value: other, tone: tight ? ("attn" as const) : undefined }] : []),
                    ]}
                  />
                </div>
              </div>
            )}
          </Panel>

          <Panel title="What could go" meta={data ? "Each cleanup shows exactly what it removes first" : undefined} flush>
            {!data ? (
              <ul className={s.kinds} aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <li key={i} className={s.kind}>
                    <span className={s.kindName}>
                      <Skeleton width={90} height={14} />
                      <Skeleton width={180} height={11} />
                    </span>
                    <Skeleton height={6} />
                    <Skeleton width={150} height={28} radius={7} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className={`${s.kinds} appear`}>
                {kinds.map((k) => {
                  const share = k.bytes > 0 ? Math.min(1, k.free / k.bytes) : 0;
                  return (
                    <li key={k.key} className={s.kind}>
                      <span className={s.kindName}>
                        <strong>{k.href ? <Link href={k.href}>{k.name}</Link> : k.name}</strong>
                        <span>{k.what}</span>
                      </span>
                      <span className={s.kindFigures}>
                        <span className={s.kindBytes}>
                          <b>{fmt.bytes(k.bytes)}</b>
                          {k.free > 0 ? (
                            <span>
                              {k.freeWords} {fmt.bytes(k.free)} could go
                            </span>
                          ) : (
                            <span>all in use</span>
                          )}
                        </span>
                        <span className={s.kindTrack} role="meter" aria-label={`${k.name}: share that could go`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                          {share < 1 && <span style={{ width: `${(1 - share) * 100}%` }} />}
                          {share > 0 && <span data-free="" style={{ left: `${(1 - share) * 100}%`, width: `${share * 100}%` }} />}
                        </span>
                      </span>
                      <span className={s.kindAction}>
                        <Button size="sm" disabled={k.free <= 0 && k.key !== "images"} onClick={() => setCleanup(k.key)}>
                          {k.free > 0 ? `${k.action}…` : k.key === "images" ? "Check unused images…" : "Nothing to free"}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {data && (
            <div className={s.legend} aria-hidden>
              <span>
                <i /> Kept
              </span>
              <span>
                <i data-free="" /> Could go
              </span>
              <span>Image sizes count shared layers once. Removing an image frees its own layers; shared ones stay while another image needs them.</span>
            </div>
          )}
        </div>
      )}
      {cleanup && (
        <CleanupDialog
          kind={cleanup}
          open={!!cleanup}
          onClose={() => setCleanup(null)}
          onDone={() => {
            setFresh((n) => n + 1);
            void mutate();
          }}
        />
      )}
    </Page>
  );
}
