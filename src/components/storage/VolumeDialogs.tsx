"use client";
import * as React from "react";
import Link from "next/link";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, Switch, SettingRow, Checkbox } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import type { DiskView, MountPlan, PersistPlan, StorageJob, UnmountPlan, VolumeUser, VolumeView } from "@/lib/storage-types";
import { AppsUsing, BeforeAfter, FstabChange } from "./BeforeAfter";
import s from "./storage.module.css";

const OPS = "/api/storage/operations";

export function errorText(e: unknown, fallback = "That didn't work."): string | null {
  if (e instanceof ApiError && e.code === "reauth_cancelled") return null;
  return e instanceof Error ? e.message : fallback;
}

/** The storage change that's running right now, if any (so conflicting buttons can be disabled). */
export function useRunningJob(): StorageJob | null {
  const { data } = useApi<StorageJob[]>(`${OPS}?limit=10`, { refresh: 5000 });
  return data?.find((j) => j.status === "running" && j.kind !== "usage") ?? null;
}

function suggestPath(v: VolumeView): string {
  const base = (v.label ?? v.name).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || v.name;
  return `/mnt/${base}`;
}

function Problems({ blockers, warnings }: { blockers: string[]; warnings: string[] }) {
  return (
    <>
      {blockers.length > 0 && (
        <Notice tone="fault" title={blockers.length === 1 ? "This can't be done yet" : "These need sorting first"}>
          <ul className={s.plainList}>
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice tone="attention">
          <ul className={s.plainList}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

// ---------------------------------------------------------------- mount

export function MountDialog({ vol, disk, onClose, onDone }: { vol: VolumeView | null; disk: DiskView | null; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = React.useState("");
  const [persist, setPersist] = React.useState(true);
  const [readOnly, setReadOnly] = React.useState(false);
  const [plan, setPlan] = React.useState<MountPlan | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!vol) return;
    setTarget(suggestPath(vol));
    setPersist(true);
    setReadOnly(vol.deviceReadOnly);
    setError(null);
    setPlan(null);
  }, [vol]);

  React.useEffect(() => {
    if (!vol || !target.trim().startsWith("/")) return;
    setChecking(true);
    const t = setTimeout(() => {
      api
        .post<MountPlan>("/api/storage/plan", { op: "mount", device: vol.path, target: target.trim(), persist })
        .then(setPlan)
        .catch((e) => setError(errorText(e)))
        .finally(() => setChecking(false));
    }, 350);
    return () => clearTimeout(t);
  }, [vol, target, persist]);

  async function go() {
    if (!vol) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>(OPS, { op: "mount", device: vol.path, target: target.trim(), persist, readOnly });
      toast.success(r.message);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = !!plan?.blockers.length;
  return (
    <Dialog
      open={!!vol}
      onOpenChange={(o) => !o && onClose()}
      title={vol ? `Mount ${vol.label ? `“${vol.label}”` : vol.name}` : "Mount"}
      description={vol && disk ? `${vol.name} on the ${disk.title}${disk.model ? ` (${disk.model})` : ""}. Its files appear in the folder you choose.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={blocked || checking || !target.trim()} onClick={() => void go()}>
            Mount at {target.trim() || "…"}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Field label="Folder" description="Usually a new folder under /mnt. Gluon creates it if it doesn't exist.">
          <Input mono value={target} onChange={(e) => setTarget(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <SettingRow label="Connect it again after a restart" description="Puts it on the startup list (/etc/fstab). With nofail, the server still starts if the drive is missing.">
          <Switch checked={persist} onChange={setPersist} aria-label="Mount it again after a restart" />
        </SettingRow>
        <SettingRow label="Read-only" description={vol?.deviceReadOnly ? "The drive is write-protected, so it can only be read." : "Apps can read files but can't change anything."}>
          <Switch checked={readOnly} onChange={setReadOnly} disabled={vol?.deviceReadOnly} aria-label="Read-only" />
        </SettingRow>
        {vol && (
          <BeforeAfter
            before={{ state: "stopped", text: "Not connected: its files can't be opened" }}
            after={{
              state: persist ? "running" : "attention",
              text: (
                <>
                  Files appear in <span className="mono">{target.trim() || "…"}</span>
                  {persist ? ", and again after every restart" : ", until the next restart"}
                </>
              ),
            }}
          />
        )}
        {persist && plan?.fstabLine && !blocked && <FstabChange line={null} before={null} after={plan.fstabLine} />}
        {plan && <Problems blockers={plan.blockers} warnings={plan.warnings} />}
        {error && <Notice tone="fault">{error}</Notice>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- unmount

export function UnmountDialog({ target, onClose, onDone }: { target: string | null; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = React.useState<UnmountPlan | null>(null);
  const [removeLine, setRemoveLine] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const check = React.useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      setPlan(await api.post<UnmountPlan>("/api/storage/plan", { op: "unmount", target }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [target]);

  React.useEffect(() => {
    setPlan(null);
    setRemoveLine(false);
    void check();
  }, [check]);

  async function go() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>(OPS, { op: "unmount", target, removeFromFstab: removeLine });
      toast.success(r.message);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
      void check();
    } finally {
      setBusy(false);
    }
  }

  const apps = [...new Map((plan?.holders ?? []).filter((h) => h.container?.appId).map((h) => [h.container!.appId!, h.container!.appId!])).values()];
  const systemBlock = plan?.blockers.some((b) => /system disk/.test(b));
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={`Unmount ${target ?? ""}`}
      description="Its files stay on the drive; they just stop appearing in this folder until it's mounted again."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {plan && plan.blockers.length > 0 && !systemBlock && (
            <Button loading={loading} onClick={() => void check()}>
              Check again
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={!plan || plan.blockers.length > 0} onClick={() => void go()}>
            Unmount
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {!plan && loading && (
          <>
            <Skeleton height={14} width="60%" />
            <Skeleton height={14} width="45%" />
          </>
        )}
        {plan && plan.holders.length > 0 && (
          <Notice tone="attention" title="It's in use">
            <p>Stop these first, then check again:</p>
            <ul className={s.plainList}>
              {plan.holders.map((h, i) => (
                <li key={i}>
                  {h.label}
                  {h.container?.appId && (
                    <>
                      {" "}
                      <Link href={`/apps/${encodeURIComponent(h.container.appId)}`}>Open app</Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {apps.length > 0 && <p className={s.muted}>Stopping an app from its page is safe: its files stay where they are.</p>}
          </Notice>
        )}
        {plan && (
          <BeforeAfter
            before={{ state: plan.holders.length ? "attention" : "running", text: <>Files show in <span className="mono">{target}</span>{plan.holders.length ? `; ${plan.holders.length === 1 ? "one thing is" : `${plan.holders.length} things are`} using them` : ""}</> }}
            after={{ state: "stopped", text: <>The folder is empty; the files stay on the drive</> }}
          />
        )}
        {plan && plan.holders.length === 0 && plan.blockers.length === 0 && <p className={s.muted}>Nothing is using it right now.</p>}
        {plan && <Problems blockers={plan.blockers.filter((b) => !b.startsWith("It's in use"))} warnings={plan.fstabLine ? [] : plan.warnings} />}
        {plan?.fstabLine && (
          <div className={s.stack}>
            <Checkbox checked={removeLine} onChange={setRemoveLine}>
              Also take it off the startup list (/etc/fstab), so it isn't connected again after a restart
            </Checkbox>
            <pre className={s.code}>
              {plan.fstabLine.line}: {plan.fstabLine.text}
            </pre>
          </div>
        )}
        {error && <Notice tone="fault">{error}</Notice>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- make permanent

export function PersistDialog({ target, hdd, users = [], onClose, onDone }: { target: string | null; hdd: boolean; users?: VolumeUser[]; onClose: () => void; onDone: () => void }) {
  const fmt = useFormat();
  const [noatime, setNoatime] = React.useState(hdd);
  const [plan, setPlan] = React.useState<PersistPlan | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setNoatime(hdd);
    setError(null);
  }, [target, hdd]);

  React.useEffect(() => {
    if (!target) return;
    setPlan(null);
    api
      .post<PersistPlan>("/api/storage/plan", { op: "persist", targets: [target], noatime })
      .then(setPlan)
      .catch((e) => setError(errorText(e)));
  }, [target, noatime]);

  async function go() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>(OPS, { op: "persist", targets: [target], noatime });
      toast.success(r.message);
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const item = plan?.items[0];
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={`Keep ${target ?? ""} after a restart`}
      description="Gluon puts it on the startup list, by an ID that doesn't change when drives are added or moved."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!item} onClick={() => void go()}>
            Make permanent
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {target && (
          <BeforeAfter
            before={{ state: "attention", text: <>Connected at <span className="mono">{target}</span> until the next restart</> }}
            after={{ state: "running", text: "Connected again at every start" }}
          />
        )}
        <AppsUsing users={users} lead={(names, n) => <>{names} {n === 1 ? "keeps its" : "keep their"} files here, so {n === 1 ? "it" : "they"}'ll find them after a restart too.</>} />
        {!plan && !error && <Skeleton height={60} />}
        {item && <FstabChange line={item.line} before={item.before} after={item.after} />}
        {plan?.skipped.map((x) => (
          <Notice key={x.target}>{x.reason}</Notice>
        ))}
        <SettingRow label="Don't record access times (noatime)" description={hdd ? "Recommended for hard drives: fewer writes, and it lets them sleep." : "Saves a few writes. Rarely matters on SSDs."}>
          <Switch checked={noatime} onChange={setNoatime} aria-label="noatime" />
        </SettingRow>
        <p className={s.hint}>The new list is checked before it's used. “nofail” means the server still starts normally if this drive is ever missing; it waits at most {fmt.duration(30)} for it.</p>
        {error && <Notice tone="fault">{error}</Notice>}
      </div>
    </Dialog>
  );
}
