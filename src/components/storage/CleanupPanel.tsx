"use client";
import * as React from "react";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import type { CleanupPreview } from "@/lib/storage-types";
import { errorText } from "./VolumeDialogs";
import s from "./storage.module.css";

const MB = 1_000_000;
/** Round decimal sizes so the labels read "Keep 200 MB" (the server takes whole MiB, slightly less). */
const KEEP = [100 * MB, 200 * MB, 500 * MB, 1000 * MB] as const;

export function DockerSpace({ data }: { data: CleanupPreview | undefined }) {
  const fmt = useFormat();
  const u = data?.docker?.usage;
  return (
    <Panel title="Docker" meta={u ? <span className="num">{fmt.bytes(u.images.bytes + u.containers.bytes + u.volumes.bytes + u.buildCache.bytes)}</span> : undefined} flush>
      {!data ? (
        <div className={s.pad}>
          <Skeleton height={80} />
        </div>
      ) : !u ? (
        <div className={s.pad}>
          <Notice tone="fault">Gluon couldn't ask Docker how much space it uses. Check that Docker is running.</Notice>
        </div>
      ) : (
        <dl className={s.kvRows}>
          {(
            [
              ["Images", u.images, "not used by any container"],
              ["Containers", u.containers, "in stopped containers"],
              ["Volumes", u.volumes, "in volumes no container uses"],
              ["Build cache", u.buildCache, "reusable"],
            ] as const
          ).map(([label, v, what]) => (
            <React.Fragment key={label}>
              <dt>
                {label} <span className={`${s.muted} num`}>{v.count}</span>
              </dt>
              <dd className="num">
                {fmt.bytes(v.bytes)}
                {v.reclaimable > 0 && (
                  <span className={s.muted}>
                    {" "}
                    · {fmt.bytes(v.reclaimable)} {what}
                  </span>
                )}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </Panel>
  );
}

/**
 * The cleanups that need no picking (the old Docker copy, apt's cache, the journal), each behind its
 * confirmation. Shared by the Clean up panel and the Space map, which hangs them on the blocks where
 * the space actually is.
 */
export function useCleanupActions(onChanged?: () => void) {
  const fmt = useFormat();
  const { data, mutate } = useApi<CleanupPreview>("/api/storage/cleanup", { refresh: 60_000 });
  const [confirm, confirmNode] = useConfirm();

  const run = React.useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await api.post<{ message: string; problems: string[] }>("/api/storage/operations", { op: "cleanup", ...body });
        (r.problems?.length ? toast.info : toast.success)(r.message);
        void mutate();
        onChanged?.();
      } catch (e) {
        const m = errorText(e);
        if (m) throw new Error(m);
      }
    },
    [mutate, onChanged],
  );

  const leftovers = () => {
    const l = data?.leftovers;
    if (!l) return;
    confirm({
      title: "Delete the old storage copy?",
      consequences: [`Deletes ${l.paths.join(" and ")} (${fmt.bytes(l.bytes)}).`, "Docker now runs from its new place; your apps won't notice.", "This can't be undone."],
      confirmLabel: `Free ${fmt.bytes(l.bytes)}`,
      onConfirm: async () => {
        try {
          const r = await api.post<{ message: string }>("/api/remedies", { action: l.action, params: { paths: l.paths }, findingId: null });
          toast.success(r.message);
          void mutate();
          onChanged?.();
        } catch (e) {
          const m = errorText(e);
          if (m) throw new Error(m);
        }
      },
    });
  };

  const apt = () => {
    if (!data) return;
    confirm({
      title: "Clear the package download cache?",
      consequences: [`Deletes ${fmt.plural(data.apt.files, "downloaded package")} (${fmt.bytes(data.apt.bytes)}) from /var/cache/apt.`, "Installed software isn't affected."],
      confirmLabel: "Clear",
      variant: "primary",
      onConfirm: () => run({ kind: "apt" }),
    });
  };

  const journal = (keep: number) => {
    if (!data) return;
    confirm({
      title: `Shrink the system log to ${fmt.bytes(keep)}?`,
      consequences: [`Deletes the oldest log files until it takes ${fmt.bytes(keep)} (it's ${fmt.bytes(data.journal.bytes)} now).`, "Recent logs are kept, so current problems can still be looked into.", "Older history is gone for good."],
      confirmLabel: "Shrink",
      variant: "primary",
      onConfirm: () => run({ kind: "journal", keepBytes: keep }),
    });
  };

  return { data, mutate, run, confirm, confirmNode, leftovers, apt, journal };
}

/** A journal size to keep that reads as a round number ("Keep 200 MB"). */
export function keepFor(data: CleanupPreview | undefined): number {
  return KEEP.find((k) => k >= (data?.journal.suggestedKeep ?? 0)) ?? 200 * MB;
}

export function CleanupPanel({ onChanged }: { onChanged?: () => void }) {
  const fmt = useFormat();
  const { error } = useApi<CleanupPreview>("/api/storage/cleanup", { refresh: 60_000 });
  const actions = useCleanupActions(onChanged);
  const { data, confirm, confirmNode } = actions;
  const [keep, setKeep] = React.useState<string>(String(200 * MB));
  const [images, setImages] = React.useState(true);
  const [cache, setCache] = React.useState(true);
  const [ctrs, setCtrs] = React.useState<Set<string>>(new Set());
  const [vols, setVols] = React.useState<Set<string>>(new Set());

  const suggested = data?.journal.suggestedKeep;
  React.useEffect(() => {
    if (suggested !== undefined) setKeep(String(keepFor(data)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);

  async function run(body: Record<string, unknown>) {
    await actions.run(body);
    setCtrs(new Set());
    setVols(new Set());
  }

  const d = data?.docker;
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  };
  const dockerSelected = {
    images: images && !!d?.danglingImages.length,
    cache: cache && !!d && d.buildCache.bytes > 0,
    ctrs: d?.stoppedContainers.filter((c) => ctrs.has(c.id)) ?? [],
    vols: d?.unusedVolumes.filter((v) => vols.has(v.name)) ?? [],
  };
  const dockerBytes =
    (dockerSelected.images ? d!.danglingImages.reduce((a, i) => a + i.bytes, 0) : 0) +
    (dockerSelected.cache ? d!.buildCache.bytes : 0) +
    dockerSelected.ctrs.reduce((a, c) => a + c.bytes, 0) +
    dockerSelected.vols.reduce((a, v) => a + (v.bytes ?? 0), 0);
  const anyDocker = dockerSelected.images || dockerSelected.cache || dockerSelected.ctrs.length > 0 || dockerSelected.vols.length > 0;

  return (
    <>
      <Panel title="Clean up" meta={data ? <span>Nothing is removed without asking</span> : undefined} flush>
        {error && (
          <div className={s.pad}>
            <Notice tone="fault">{error.message}</Notice>
          </div>
        )}
        {!data && !error && (
          <div className={s.pad}>
            <div className={s.stack}>
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          </div>
        )}
        {data && (
          <ul className={s.cleanups} role="list">
            {data.leftovers && (
              <li className={s.cleanup}>
                <div className={s.cleanupText}>
                  <p className={s.cleanupTitle}>Old copy of Docker's storage</p>
                  <p className={s.muted}>
                    <span className="mono">{data.leftovers.paths.join(", ")}</span> was kept after Docker moved{data.dockerRoot ? <> to <span className="mono">{data.dockerRoot}</span></> : null}. Nothing uses it.
                  </p>
                </div>
                <span className={`${s.cleanupSize} num`}>{fmt.bytes(data.leftovers.bytes)}</span>
                <Button size="sm" variant="secondary" onClick={actions.leftovers}>
                  Free {fmt.bytes(data.leftovers.bytes)}
                </Button>
              </li>
            )}

            <li className={s.cleanup}>
              <div className={s.cleanupText}>
                <p className={s.cleanupTitle}>Downloaded update packages</p>
                <p className={s.muted}>Copies of packages apt already installed. It downloads them again if it ever needs them.</p>
              </div>
              <span className={`${s.cleanupSize} num`}>{fmt.bytes(data.apt.bytes)}</span>
              <Button size="sm" disabled={data.apt.bytes < MB} onClick={actions.apt}>
                Clear
              </Button>
            </li>

            <li className={s.cleanup}>
              <div className={s.cleanupText}>
                <p className={s.cleanupTitle}>System log</p>
                <p className={s.muted}>The journal of everything Linux and its services did. The oldest entries go first.</p>
              </div>
              <span className={`${s.cleanupSize} num`}>{fmt.bytes(data.journal.bytes)}</span>
              <span className={s.cleanupControls}>
                <Select aria-label="Keep" value={keep} onChange={setKeep} options={KEEP.map((k) => ({ value: String(k), label: `Keep ${fmt.bytes(k)}` }))} />
                <Button size="sm" disabled={data.journal.bytes <= Number(keep)} onClick={() => actions.journal(Number(keep))}>
                  Shrink
                </Button>
              </span>
            </li>

            <li className={s.cleanup} data-wide="" id="cleanup-docker" tabIndex={-1}>
              <div className={s.cleanupText}>
                <p className={s.cleanupTitle}>Docker leftovers</p>
                <p className={s.muted}>Pick what goes. Images and build cache come back on the next download or build.</p>
              </div>
              {!d ? (
                <Notice tone="fault">Gluon couldn't reach Docker.</Notice>
              ) : d.danglingImages.length + d.stoppedContainers.length + d.unusedVolumes.length === 0 && d.buildCache.bytes === 0 ? (
                <Empty title="Nothing to clean up">Docker has no unused images, stopped containers or orphaned volumes.</Empty>
              ) : (
                <div className={s.pickList}>
                  {d.danglingImages.length > 0 && (
                    <Checkbox checked={images} onChange={setImages}>
                      {fmt.plural(d.danglingImages.length, "unused image layer")} <span className={`${s.muted} num`}>{fmt.bytes(d.danglingImages.reduce((a, i) => a + i.bytes, 0))}</span>
                    </Checkbox>
                  )}
                  {d.buildCache.bytes > 0 && (
                    <Checkbox checked={cache} onChange={setCache}>
                      Build cache <span className={`${s.muted} num`}>{fmt.bytes(d.buildCache.bytes)}</span>
                    </Checkbox>
                  )}
                  {d.stoppedContainers.length > 0 && (
                    <fieldset className={s.pickGroup}>
                      <legend className="label">Stopped containers</legend>
                      <p className={s.hint}>An app's stopped containers are recreated when you start it again from Apps.</p>
                      {d.stoppedContainers.map((c) => (
                        <Checkbox key={c.id} checked={ctrs.has(c.id)} onChange={(on) => setCtrs((x) => toggle(x, c.id, on))}>
                          <span className="mono">{c.name}</span> <span className={s.muted}>{[c.app, c.status].filter(Boolean).join(" · ")}</span>
                        </Checkbox>
                      ))}
                    </fieldset>
                  )}
                  {d.unusedVolumes.length > 0 && (
                    <fieldset className={s.pickGroup}>
                      <legend className="label">Volumes no container uses</legend>
                      {d.unusedVolumes.some((v) => !v.anonymous) && <p className={s.hint}>Named volumes can hold an app's data (for example an app you removed but might reinstall). Only pick the ones you're sure about.</p>}
                      {d.unusedVolumes.map((v) => (
                        <Checkbox key={v.name} checked={vols.has(v.name)} onChange={(on) => setVols((x) => toggle(x, v.name, on))}>
                          <span className="mono truncate" title={v.name}>
                            {v.anonymous ? `${v.name.slice(0, 12)}… (unnamed)` : v.name}
                          </span>{" "}
                          <span className={`${s.muted} num`}>{[v.app, v.bytes !== null ? fmt.bytes(v.bytes) : null].filter(Boolean).join(" · ")}</span>
                        </Checkbox>
                      ))}
                    </fieldset>
                  )}
                  <div>
                    <Button
                      size="sm"
                      disabled={!anyDocker}
                      onClick={() =>
                        confirm({
                          title: `Remove ${fmt.bytes(dockerBytes)} of Docker leftovers?`,
                          consequences: [
                            ...(dockerSelected.images ? [`${fmt.plural(d.danglingImages.length, "unused image layer")} (${fmt.bytes(d.danglingImages.reduce((a, i) => a + i.bytes, 0))}).`] : []),
                            ...(dockerSelected.cache ? [`The build cache (${fmt.bytes(d.buildCache.bytes)}).`] : []),
                            ...dockerSelected.ctrs.map((c) => `Container ${c.name}${c.app ? ` (${c.app})` : ""}.`),
                            ...dockerSelected.vols.map((v) => `Volume ${v.anonymous ? v.name.slice(0, 12) + "…" : v.name}${v.bytes !== null ? ` (${fmt.bytes(v.bytes)})` : ""}: its data is deleted for good.`),
                          ],
                          confirmLabel: "Remove",
                          onConfirm: () =>
                            run({
                              kind: "docker",
                              danglingImages: dockerSelected.images,
                              buildCache: dockerSelected.cache,
                              containers: dockerSelected.ctrs.map((c) => c.id),
                              volumes: dockerSelected.vols.map((v) => v.name),
                            }),
                        })
                      }
                    >
                      Remove selected{anyDocker ? ` (${fmt.bytes(dockerBytes)})` : ""}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          </ul>
        )}
        {data?.warnings.filter((w) => !/named/.test(w)).map((w) => (
          <div className={s.pad} key={w}>
            <Notice tone="attention">{w}</Notice>
          </div>
        ))}
      </Panel>
      <DockerSpace data={data} />
      {confirmNode}
    </>
  );
}
