"use client";
import * as React from "react";
import { Pause, Play, Xmark, Undo, Refresh } from "iconoir-react";
import type { FileJob } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { Disclosure } from "@/components/ui/Disclosure";
import { uploads, useUploads, type UploadItem } from "./uploads";
import s from "./files.module.css";

const UPLOAD_TEXT: Record<UploadItem["status"], string> = {
  queued: "Waiting",
  starting: "Starting",
  uploading: "Uploading",
  paused: "Paused",
  waiting: "Reconnecting",
  completing: "Saving",
  done: "Uploaded",
  skipped: "Skipped — already there",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function Progress({ value, max, state }: { value: number; max: number; state?: "done" | "failed" | "paused" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : state === "done" ? 100 : 0;
  return (
    <div className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} data-state={state}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Bottom-right tray: uploads (with pause, resume, cancel, speed and time left) and background file
 * tasks (copy, move, extract, ownership, emptying the trash). Hidden when there's nothing to show.
 */
export function Tray({ jobs, onCancelJob, onUndo, onClearJobs }: { jobs: FileJob[]; onCancelJob: (id: string) => void; onUndo: (job: FileJob) => void; onClearJobs: () => void }) {
  const fmt = useFormat();
  const list = useUploads();
  const [open, setOpen] = React.useState(true);
  const picker = React.useRef<HTMLInputElement>(null);
  // Stay mounted for the exit, so the tray slides away instead of vanishing.
  const visible = list.length > 0 || jobs.length > 0;
  const [mounted, setMounted] = React.useState(visible);
  const [leaving, setLeaving] = React.useState(false);
  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const t = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, 200);
    return () => clearTimeout(t);
  }, [visible]);

  const activeUploads = list.filter((u) => ["queued", "starting", "uploading", "waiting", "completing"].includes(u.status));
  const interrupted = list.filter((u) => u.status === "interrupted");
  const runningJobs = jobs.filter((j) => j.status === "running" || j.status === "queued");
  if (!mounted) return null;

  const speed = activeUploads.reduce((a, u) => a + u.speed, 0);
  const remaining = activeUploads.reduce((a, u) => a + (u.size - u.received), 0);
  const eta = speed > 0 ? remaining / speed : null;
  const parts: string[] = [];
  if (activeUploads.length) parts.push(`Uploading ${fmt.plural(activeUploads.length, "file")}${speed ? ` · ${fmt.rate(speed)}` : ""}${eta !== null ? ` · ${fmt.duration(eta)} left` : ""}`);
  if (runningJobs.length) parts.push(`${fmt.plural(runningJobs.length, "task")} running`);
  if (interrupted.length) parts.push(`${fmt.plural(interrupted.length, "upload")} interrupted`);
  const headline = parts.join(" · ") || "All done";
  // One line across the head for everything in flight, so the tray reads even when it's folded.
  const inFlight = activeUploads.reduce((a, u) => ({ got: a.got + u.received, of: a.of + u.size }), { got: 0, of: 0 });
  const overall = inFlight.of > 0 ? Math.min(100, (inFlight.got / inFlight.of) * 100) : null;

  return (
    <section className={s.tray} aria-label="Uploads and tasks" data-leaving={leaving ? "" : undefined} data-motion-gentle="">
      {overall !== null && (
        <span className={s.trayOverall} role="progressbar" aria-label="All uploads" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall)}>
          <span style={{ width: `${overall}%` }} />
        </span>
      )}
      {!activeUploads.length && !runningJobs.length && (
        <Button
          size="sm"
          variant="ghost"
          className={s.trayClear}
          onClick={() => {
            uploads.clearFinished();
            onClearJobs();
          }}
        >
          Clear
        </Button>
      )}
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        className={s.trayDisc}
        summary={
          <span className={`${s.trayHeadline} truncate num`}>
            {overall !== null && <b className={s.trayPct}>{Math.floor(overall)}%</b>}
            {headline}
          </span>
        }
      >
        <div className={s.trayBody}>
          {interrupted.length > 0 && (
            <div className={s.trayNote}>
              <p>
                {fmt.plural(interrupted.length, "upload")} stopped when the page was closed. Choose the same files again to continue where they left off.
              </p>
              <Button size="sm" onClick={() => picker.current?.click()}>
                Choose files
              </Button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  const n = uploads.attach(files);
                  if (!n) toast.error("Those aren't the same files", { description: "Choose files with the same names and sizes as the interrupted uploads." });
                  else toast.info(`Resuming ${fmt.plural(n, "upload")}`);
                }}
              />
            </div>
          )}
          <ul className={s.trayList}>
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} onCancel={() => onCancelJob(j.id)} onUndo={() => onUndo(j)} />
            ))}
            {list.map((u) => (
              <li key={u.key} className={s.trayItem}>
                <div className={s.trayLine}>
                  <span className="truncate" title={`${u.dir}/${u.name}`}>
                    {u.name}
                  </span>
                  <span className={s.trayActions}>
                    {(u.status === "uploading" || u.status === "queued" || u.status === "waiting") && (
                      <IconButton label="Pause" size="sm" onClick={() => uploads.pause(u.key)}>
                        <Pause />
                      </IconButton>
                    )}
                    {(u.status === "paused" || (u.status === "failed" && u.file)) && (
                      <IconButton label={u.status === "failed" ? "Try again" : "Resume"} size="sm" onClick={() => uploads.resume(u.key)}>
                        {u.status === "failed" ? <Refresh /> : <Play />}
                      </IconButton>
                    )}
                    {["done", "skipped", "cancelled", "failed"].includes(u.status) ? (
                      <IconButton label="Remove from list" size="sm" onClick={() => uploads.dismiss(u.key)}>
                        <Xmark />
                      </IconButton>
                    ) : (
                      u.status !== "completing" && (
                        <IconButton label="Cancel upload" size="sm" onClick={() => void uploads.cancel(u.key)}>
                          <Xmark />
                        </IconButton>
                      )
                    )}
                  </span>
                </div>
                <Progress value={u.received} max={u.size} state={u.status === "done" ? "done" : u.status === "failed" ? "failed" : u.status === "paused" ? "paused" : undefined} />
                <span className={`${s.traySub} num`} data-fault={u.status === "failed" ? "" : undefined}>
                  {u.status === "failed" || u.status === "waiting" ? (u.error ?? UPLOAD_TEXT[u.status]) : UPLOAD_TEXT[u.status]}
                  {(u.status === "uploading" || u.status === "paused" || u.status === "waiting" || u.status === "interrupted") && ` · ${fmt.bytes(u.received)} of ${fmt.bytes(u.size)}`}
                  {u.status === "uploading" && u.speed > 0 && ` · ${fmt.rate(u.speed)} · ${fmt.duration((u.size - u.received) / u.speed)} left`}
                  {u.status === "done" && ` · ${fmt.bytes(u.size)} to ${u.dir}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Disclosure>
    </section>
  );
}

function JobRow({ job, onCancel, onUndo }: { job: FileJob; onCancel: () => void; onUndo: () => void }) {
  const fmt = useFormat();
  const p = job.progress;
  const live = job.status === "running" || job.status === "queued";
  const undo = job.status === "done" && job.kind === "chown" && typeof job.result?.undo === "string";
  const counts =
    p.bytesTotal && p.bytesTotal > 0
      ? `${fmt.bytes(p.bytesDone)} of ${fmt.bytes(p.bytesTotal)}`
      : p.total
        ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()}`
        : p.done
          ? p.done.toLocaleString()
          : "";
  return (
    <li className={s.trayItem}>
      <div className={s.trayLine}>
        <span className="truncate" title={job.title}>
          {job.title}
        </span>
        <span className={s.trayActions}>
          {undo && (
            <Button size="sm" variant="ghost" icon={<Undo />} onClick={onUndo}>
              Undo
            </Button>
          )}
          {live && (
            <IconButton label="Stop this task" size="sm" onClick={onCancel}>
              <Xmark />
            </IconButton>
          )}
        </span>
      </div>
      {live && <Progress value={p.bytesTotal ? p.bytesDone : p.done} max={(p.bytesTotal ?? p.total) || 0} />}
      <span className={`${s.traySub} num`} data-fault={job.status === "failed" ? "" : undefined}>
        {live ? (
          <>
            {p.phase}
            {counts && ` · ${counts}`}
            {p.current && (
              <>
                {" · "}
                <span className="mono" title={p.current}>
                  {p.current.split("/").pop()}
                </span>
              </>
            )}
          </>
        ) : (
          (job.message ?? job.error ?? job.status)
        )}
      </span>
    </li>
  );
}
