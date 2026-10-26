"use client";
import * as React from "react";
import type { UninstallItem, UninstallPlan } from "@/lib/app-move-types";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { HoldButton } from "@/components/ui/HoldButton";
import { Checkbox, Segmented } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import s from "./move.module.css";

type Mode = "keep" | "everything";

/**
 * Uninstall an app Gluon can remove itself. Keeping the data is the default; deleting it is a
 * deliberate second choice that lists every folder and volume by name and needs a hold to confirm.
 */
export function UninstallDialog({
  app,
  open,
  onOpenChange,
  onDone,
  initialMode = "keep",
  title,
}: {
  app: { id: string; name: string };
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (message: string) => void;
  initialMode?: Mode;
  title?: string;
}) {
  const fmt = useFormat();
  const [mode, setMode] = React.useState<Mode>(initialMode);
  /** Media libraries and big folders the person ticked to delete too. */
  const [extra, setExtra] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { data: plan, error: loadError, isLoading, mutate } = useApi<UninstallPlan>(open ? `/api/apps/${encodeURIComponent(app.id)}/uninstall` : null, { revalidateOnFocus: false, keepPreviousData: false });

  React.useEffect(() => {
    if (open) {
      setMode(initialMode);
      setExtra(new Set());
      setError(null);
    }
  }, [open, initialMode]);

  async function go() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string; failed: string[] }>(`/api/apps/${encodeURIComponent(app.id)}/uninstall`, { mode, planId: plan.id, ...(mode === "everything" ? { remove: [...plan.everything.removes.map((i) => i.target), ...plan.everything.optional.filter((i) => extra.has(i.target)).map((i) => i.target)] } : {}) });
      onOpenChange(false);
      onDone(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setError(e instanceof Error ? e.message : "Gluon couldn't uninstall it.");
      if (e instanceof ApiError && e.code === "conflict") void mutate();
    } finally {
      setBusy(false);
    }
  }

  const m = plan ? (mode === "everything" ? plan.everything : plan.keep) : null;
  const n = plan?.containers.length ?? 0;
  const deletesData = mode === "everything" && (!!m?.removes.length || extra.size > 0);
  // A Gluon-run app's own folder, which keeping the data leaves in place.
  const kept = plan?.source === "gluon" ? plan.keep.keeps.find((i) => i.kind === "folder" && plan.everything.removes.some((r) => r.target === i.target)) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={title ?? `Uninstall ${app.name}?`}
      description={plan ? `Gluon stops and removes its ${n === 1 ? "container" : `${n} containers`}${plan.via === "compose" ? " with docker compose down" : ""}.` : undefined}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {deletesData ? (
            <HoldButton holdMs={1400} disabled={!plan} loading={busy} onConfirm={go}>
              {busy ? "Deleting…" : "Hold to delete everything"}
            </HoldButton>
          ) : (
            <Button variant="dangerSolid" disabled={!plan} loading={busy} onClick={() => void go()}>
              Uninstall
            </Button>
          )}
        </>
      }
    >
      {isLoading && !plan ? (
        <div className={s.review} aria-busy="true" aria-label="Checking what it uses">
          <Skeleton height={30} width={260} radius={9} />
          {[70, 52, 64].map((w, i) => (
            <Skeleton key={i} height={12} width={`${w}%`} />
          ))}
        </div>
      ) : loadError ? (
        <Notice
          tone="fault"
          title="Gluon can't uninstall it"
          action={
            <Button size="sm" onClick={() => void mutate()}>
              Check again
            </Button>
          }
        >
          {loadError.message}
        </Notice>
      ) : plan && m ? (
        <div className={s.review}>
          <Segmented
            aria-label="What happens to its data"
            value={mode}
            onChange={setMode}
            block
            options={[
              { value: "keep", label: "Keep its data" },
              { value: "everything", label: "Delete everything" },
            ]}
          />
          {kept && mode === "keep" ? (
            <p className={s.verdict}>
              Its folder <span className="mono">{kept.target}</span> stays{kept.size !== null ? <>, with <b className="num">{fmt.bytes(kept.size)}</b> of data in it</> : ", with its data in it"}. Gluon only removes the files that start the app.
            </p>
          ) : null}
          {mode === "everything" && !m.removes.length && !m.optional.length ? (
            <p className={s.none}>Gluon found no data it can delete safely. Everything it uses is outside its own folders or shared with other apps, so only its containers go.</p>
          ) : (
            <Items title={mode === "everything" ? "Deleted for good" : "Removed"} items={m.removes} empty="Only its containers. Nothing on disk is deleted." fmt={fmt} danger={mode === "everything"} />
          )}
          {mode === "everything" && m.optional.length > 0 && (
            <section className={s.group} aria-labelledby="uninstall-optional">
              <h3 id="uninstall-optional" className={s.groupTitle}>
                Kept unless you tick them <span className="num">{m.optional.length}</span>
              </h3>
              <p className={s.hint}>These look like libraries or hold a lot, so Gluon keeps them unless you pick them one by one.</p>
              <ul className={s.list}>
                {m.optional.map((i) => (
                  <li key={i.target} className={s.stay}>
                    <Checkbox
                      checked={extra.has(i.target)}
                      onChange={(on) =>
                        setExtra((cur) => {
                          const next = new Set(cur);
                          if (on) next.add(i.target);
                          else next.delete(i.target);
                          return next;
                        })
                      }
                    >
                      <span className={`${s.path} mono`} title={i.target}>
                        {i.target}
                      </span>
                    </Checkbox>
                    <span className={s.note}>
                      {i.note}
                      {i.size !== null && !i.note?.startsWith("Holds") ? <span className="num"> · {fmt.bytes(i.size)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Items title="Kept on disk" items={m.keeps} empty="Nothing." fmt={fmt} />
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

function Items({ title, items, empty, fmt, danger }: { title: string; items: UninstallItem[]; empty: string; fmt: ReturnType<typeof useFormat>; danger?: boolean }) {
  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>
        {title} {items.length > 0 && <span className="num">{items.length}</span>}
      </h3>
      {items.length === 0 ? (
        <p className={s.none}>{empty}</p>
      ) : (
        <ul className={s.list} data-danger={danger ? "" : undefined}>
          {items.map((i) => (
            <li key={`${i.kind}:${i.target}`} className={s.stay}>
              <span className={`${s.path} mono`} title={i.target}>
                {i.kind === "volume" ? `volume ${/^[0-9a-f]{64}$/.test(i.target) ? i.target.slice(0, 12) : i.target}` : i.target}
              </span>
              <span className={s.note}>
                {i.note ?? ""}
                {i.size !== null && i.size !== undefined ? <span className="num">{i.note ? ` · ${fmt.bytes(i.size)}` : fmt.bytes(i.size)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
