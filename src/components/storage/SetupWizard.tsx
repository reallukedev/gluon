"use client";
import * as React from "react";
import { api, streamPost } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { toast } from "@/components/ui/Toast";
import type { DiskView, SetupPlan } from "@/lib/storage-types";
import { emptyRun, JobOutcome, JobSteps, reduceJob, type JobEvent, type JobRun } from "./JobProgress";
import { useJobParam } from "./RenameFlow";
import { errorText } from "./VolumeDialogs";
import { allVolumes } from "./shared";
import s from "./storage.module.css";

type Phase = "look" | "name" | "review" | "run";

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

function suggestLabel(d: DiskView): string {
  const tb = d.size / 1e12;
  const size = tb >= 1 ? `${Math.round(tb * 10) / 10}tb`.replace(".", "-") : `${Math.round(d.size / 1e9)}gb`;
  return `${d.media === "hdd" ? "hdd" : d.media === "flash" ? "usb" : "ssd"}-${size}`.slice(0, 16);
}

export function SetupWizard({ disk, onClose, onDone }: { disk: DiskView | null; onClose: () => void; onDone: () => void }) {
  const fmt = useFormat();
  const setJobParam = useJobParam();
  const [phase, setPhase] = React.useState<Phase>("look");
  const [label, setLabel] = React.useState("");
  const [mountPath, setMountPath] = React.useState("");
  const [pathTouched, setPathTouched] = React.useState(false);
  const [noatime, setNoatime] = React.useState(false);
  const [plan, setPlan] = React.useState<SetupPlan | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<JobRun>(emptyRun);
  const [running, setRunning] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  React.useEffect(() => {
    if (!disk) return;
    const l = suggestLabel(disk);
    setPhase("look");
    setLabel(l);
    setMountPath(`/mnt/${l}`);
    setPathTouched(false);
    setNoatime(disk.rotational);
    setPlan(null);
    setError(null);
    setRun(emptyRun);
  }, [disk]);

  React.useEffect(() => {
    if (!pathTouched) setMountPath(`/mnt/${label.trim() || "…"}`);
  }, [label, pathTouched]);

  async function makePlan() {
    if (!disk) return;
    setPlanning(true);
    setError(null);
    try {
      const p = await api.post<SetupPlan>("/api/storage/plan", { op: "setup", disk: disk.id, label: label.trim(), mountPath: mountPath.trim(), noatime });
      setPlan(p);
      setPhase("review");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPlanning(false);
    }
  }

  async function execute(p: SetupPlan) {
    setPhase("run");
    setRun(emptyRun);
    setRunning(true);
    try {
      await streamPost<JobEvent>(
        "/api/storage/operations",
        { op: "setup", disk: p.disk.id, label: p.label, mountPath: p.mountPath, noatime, planHash: p.hash, confirmSerial: p.confirmWith },
        (e) => {
          if (e.type === "job") setJobParam(e.job.id);
          setRun((st) => reduceJob(st, e));
          if (e.type === "done") {
            if (e.ok) toast.success(e.message);
            onDone();
          }
        },
      );
    } catch (e) {
      const msg = errorText(e);
      if (msg === null) setPhase("review");
      else setRun((st) => reduceJob(st, { type: "error", message: msg }));
    } finally {
      setRunning(false);
    }
  }

  function askToRun(p: SetupPlan) {
    confirm({
      title: `Erase ${p.disk.title}?`,
      description: `${p.disk.model ?? p.disk.name}, serial ${p.disk.serial ?? "unknown"}.`,
      consequences: [
        p.erases.length ? `Everything on it is erased: ${p.erases.map((e) => `${e.name}${e.fstype ? ` (${e.fstype}${e.label ? ` “${e.label}”` : ""})` : ""}`).join(", ")}.` : "The disk is blank, so nothing is lost.",
        "This can't be undone.",
        `It becomes one ext4 drive named “${p.label}”, mounted at ${p.mountPath}, and comes back after restarts.`,
      ],
      typeToConfirm: p.confirmWith,
      holdMs: 1500,
      confirmLabel: "Erase and set up",
      onConfirm: () => void execute(p),
    });
  }

  const close = () => {
    if (running) return;
    if (run.job) setJobParam(null);
    onClose();
  };

  const vols = disk ? allVolumes(disk).filter((v) => v.kind === "part" || v.kind === "disk") : [];
  const labelOk = LABEL_RE.test(label.trim());

  let footer: React.ReactNode;
  if (phase === "look") {
    footer = (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => setPhase("name")}>
          Continue
        </Button>
      </>
    );
  } else if (phase === "name") {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setPhase("look")}>
          Back
        </Button>
        <Button variant="primary" loading={planning} disabled={!labelOk || !mountPath.trim().startsWith("/")} onClick={() => void makePlan()}>
          Review
        </Button>
      </>
    );
  } else if (phase === "review" && plan) {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setPhase("name")}>
          Back
        </Button>
        <Button variant="danger" disabled={plan.blockers.length > 0} onClick={() => askToRun(plan)}>
          Erase and set up…
        </Button>
      </>
    );
  } else {
    footer = (
      <Button variant={running ? "ghost" : "primary"} disabled={running} onClick={close}>
        {running ? "Working…" : "Close"}
      </Button>
    );
  }

  return (
    <>
      <Dialog
        open={!!disk}
        onOpenChange={(o) => !o && close()}
        title={phase === "run" ? `Setting up the ${disk?.title ?? "disk"}` : `Set up the ${disk?.title ?? "disk"}`}
        description={phase === "look" ? "Gluon erases it, formats it as one ext4 drive, mounts it and keeps it mounted after restarts." : undefined}
        size="wide"
        footer={footer}
      >
        <div className={s.flowHead}>
          <FlowSteps
            label="Set up a disk"
            steps={[
              { key: "look", label: "Check the disk" },
              { key: "name", label: "Name it" },
              { key: "review", label: "Review" },
              { key: "run", label: "Set up" },
            ]}
            current={phase}
            working={running}
            failed={!!run.result && !run.result.ok}
            complete={!!run.result?.ok}
          />
        </div>
        <div className={`${s.phaseBody} appear`} key={phase}>
        {disk && phase === "look" && (
          <div className={s.stack}>
            <p>
              <b>{disk.model ?? disk.name}</b> <span className={s.muted}>· {disk.path} · serial {disk.serial ?? "unknown"}</span>
            </p>
            {vols.length === 0 ? (
              <p className={s.muted}>It's blank: no partitions and no filesystem.</p>
            ) : (
              <>
                <p>What's on it now, which will be erased:</p>
                <ul className={s.eraseList} role="list">
                  {vols.map((v) => (
                    <li key={v.name}>
                      <span className="mono">{v.name}</span>
                      <span className="num">{fmt.bytes(v.size)}</span>
                      <span>{v.role === "lvm-member" ? "LVM volume" : v.role === "bios-boot" ? "boot partition" : v.fstype ?? "unformatted"}</span>
                      <span className={s.muted}>{v.label ? `“${v.label}”` : ""}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {disk.system && <Notice tone="fault">{disk.systemReason ?? "This is the system disk."} Gluon won't erase it.</Notice>}
            {disk.state === "in-use" && <Notice tone="fault">Something on this disk is in use. Unmount it first.</Notice>}
          </div>
        )}

        {phase === "name" && (
          <div className={s.stack}>
            <Field label="Name" description="Up to 16 letters, numbers, dashes or underscores. It's how the drive identifies itself." error={label && !labelOk ? "Use 1–16 letters, numbers, dashes or underscores." : null}>
              <Input mono value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} autoComplete="off" autoFocus />
            </Field>
            <Field label="Mount at" description="A new or empty folder.">
              <Input
                mono
                value={mountPath}
                onChange={(e) => {
                  setPathTouched(true);
                  setMountPath(e.target.value);
                }}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <SettingRow label="Don't record access times (noatime)" description={disk?.rotational ? "Recommended for hard drives: fewer writes, and it lets them sleep." : "Saves a few writes."}>
              <Switch checked={noatime} onChange={setNoatime} aria-label="noatime" />
            </SettingRow>
            {error && <Notice tone="fault">{error}</Notice>}
          </div>
        )}

        {phase === "review" && plan && (
          <div className={s.stack}>
            {plan.blockers.length > 0 && (
              <Notice tone="fault" title="This can't be done">
                <ul className={s.plainList}>
                  {plan.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {plan.warnings.length > 0 && (
              <Notice tone="attention">
                <ul className={s.plainList}>
                  {plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div>
              <p className="label">What happens</p>
              <ol className={s.planSteps}>
                {plan.steps.map((st, i) => (
                  <li key={i}>{st}</li>
                ))}
              </ol>
            </div>
            <div>
              <p className="label">Added to the startup list (/etc/fstab)</p>
              <pre className={s.code}>{plan.fstabLine.replace("<new>", "(the new UUID)")}</pre>
            </div>
            {plan.fstabRemovals.length > 0 && (
              <div>
                <p className="label">Old lines commented out</p>
                <pre className={`${s.code} ${s.codeOld}`}>{plan.fstabRemovals.map((r) => `${r.line}: ${r.text}`).join("\n")}</pre>
              </div>
            )}
          </div>
        )}
        {phase === "review" && !plan && <Skeleton height={160} />}

        {phase === "run" && (
          <div className={s.stack}>
            {run.steps.length === 0 && !run.result ? <Skeleton height={16} width="50%" /> : <JobSteps steps={run.steps} />}
            <JobOutcome run={run} />
          </div>
        )}
        </div>
      </Dialog>
      {confirmNode}
    </>
  );
}
