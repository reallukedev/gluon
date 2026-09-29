"use client";
import * as React from "react";
import { streamPost, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import type { PullEvent } from "@/lib/docker-types";
import s from "./docker.module.css";

type Phase = Extract<PullEvent, { type: "layer" }>["phase"];
interface Layer {
  id: string;
  phase: Phase;
  current: number;
  total: number;
}

const PHASE_TEXT: Record<Phase, string> = {
  waiting: "Waiting",
  downloading: "Downloading",
  verifying: "Checking",
  downloaded: "Downloaded",
  extracting: "Unpacking",
  done: "Done",
  exists: "Already here",
};

/**
 * Download an image, or check a tag for a newer version: a name field, then one row per layer with
 * its own bar, then the result in words. With `ref` set it skips the form (re-pull from a row).
 */
export function PullDialog({ open, onClose, imageRef: fixedRef, onDone }: { open: boolean; onClose: () => void; imageRef?: string | null; onDone?: () => void }) {
  const fmt = useFormat();
  const [name, setName] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [status, setStatus] = React.useState<string>("");
  const [layers, setLayers] = React.useState<Layer[]>([]);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [current, setCurrent] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  const reset = React.useCallback(() => {
    setStatus("");
    setLayers([]);
    setResult(null);
    setFieldError(null);
    setCurrent(null);
  }, []);

  const run = React.useCallback(
    async (ref: string) => {
      reset();
      setCurrent(ref);
      setRunning(true);
      const ac = new AbortController();
      abort.current = ac;
      try {
        await streamPost<PullEvent>(
          "/api/docker/images/pull",
          { ref },
          (e) => {
            if (e.type === "status") setStatus(e.text);
            else if (e.type === "layer")
              setLayers((cur) => {
                const i = cur.findIndex((l) => l.id === e.id);
                const prev = i >= 0 ? cur[i]! : { id: e.id, phase: "waiting" as Phase, current: 0, total: 0 };
                const next: Layer = { id: e.id, phase: e.phase, current: e.current ?? (e.phase === prev.phase ? prev.current : 0), total: e.total ?? (e.phase === prev.phase ? prev.total : 0) };
                if (i < 0) return [...cur, next];
                const copy = cur.slice();
                copy[i] = next;
                return copy;
              });
            else if (e.type === "done") {
              setResult({ ok: e.ok, message: e.message });
              if (e.ok) onDoneRef.current?.();
            } else if (e.type === "error") setResult({ ok: false, message: e.message });
          },
          ac.signal,
        );
      } catch (e) {
        if (ac.signal.aborted) setResult({ ok: false, message: "Stopped. Layers that finished stay on the server." });
        else if (e instanceof ApiError && e.field === "ref" && !fixedRef) {
          setCurrent(null);
          setFieldError(e.message);
        }
        else if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setResult({ ok: false, message: e instanceof Error ? e.message : "The download failed." });
      } finally {
        setRunning(false);
        abort.current = null;
      }
    },
    [fixedRef, reset],
  );

  // Each time the dialog opens: start the download straight away for a known tag, else show the form.
  const runRef = React.useRef(run);
  runRef.current = run;
  React.useEffect(() => {
    if (!open) return;
    setName("");
    reset();
    if (fixedRef) void runRef.current(fixedRef);
  }, [open, fixedRef, reset]);

  const showForm = !fixedRef && !current;
  const moving = layers.filter((l) => l.phase === "downloading" && l.total > 0);
  const got = moving.reduce((a, l) => a + l.current, 0);
  const of = moving.reduce((a, l) => a + l.total, 0);
  const finished = layers.filter((l) => l.phase === "done" || l.phase === "exists" || (l.phase === "downloaded" && !running)).length;
  const title = current ? (running ? `Downloading ${current}` : current) : "Download an image";

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const v = name.trim();
    if (!v) {
      setFieldError("Type the name of an image, like jellyfin/jellyfin:latest.");
      return;
    }
    void run(v);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !running && onClose()}
      title={title}
      description={showForm ? "From Docker Hub or another public registry. Without a tag, Docker takes latest." : undefined}
      size="wide"
      footer={
        showForm ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => submit()}>
              Download
            </Button>
          </>
        ) : running ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <>
            {!fixedRef && result && !result.ok && (
              <Button variant="ghost" onClick={() => reset()}>
                Change the name
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {result?.ok ? "Done" : "Close"}
            </Button>
          </>
        )
      }
    >
      {showForm ? (
        <form className={s.pullForm} onSubmit={submit}>
          <Field label="Image" error={fieldError} description="Like ghcr.io/immich-app/immich-server:release or alpine:3.20">
            <Input
              mono
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                setFieldError(null);
              }}
              placeholder="jellyfin/jellyfin:latest"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        </form>
      ) : (
        <div aria-live="polite">
          {!result && <p className={s.pullStatus}>{status || (running ? "Asking the registry…" : "")}</p>}
          {layers.length > 0 && (
            <>
              <ul className={s.layers} aria-label="Layers">
                {layers.map((l) => {
                  const pct = l.total > 0 ? Math.min(1, l.current / l.total) : l.phase === "done" || l.phase === "exists" || l.phase === "verifying" || l.phase === "downloaded" ? 1 : 0;
                  const indeterminate = (l.phase === "extracting" || l.phase === "downloading") && l.total <= 0;
                  return (
                    <li key={l.id} className={s.layer} data-phase={l.phase}>
                      <span className={s.layerId}>{l.id.slice(0, 12)}</span>
                      <span className={s.layerTrack} role="progressbar" aria-label={`Layer ${l.id.slice(0, 12)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct * 100)}>
                        <span style={indeterminate ? undefined : { transform: `scaleX(${pct})` }} data-indeterminate={indeterminate ? "" : undefined} />
                      </span>
                      <span className={s.layerText}>
                        {l.phase === "downloading" && l.total > 0 ? `${fmt.bytes(l.current)} of ${fmt.bytes(l.total)}` : l.phase === "extracting" && l.total > 0 ? `Unpacking ${Math.round(pct * 100)}%` : PHASE_TEXT[l.phase]}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className={s.pullTotals}>
                <span>
                  {finished} of {fmt.plural(layers.length, "layer")} ready
                </span>
                {of > 0 && running && (
                  <span>
                    {fmt.bytes(got)} of {fmt.bytes(of)} downloading
                  </span>
                )}
              </div>
            </>
          )}
          {result && (
            <div className={s.pullResult}>
              <Notice tone={result.ok ? "neutral" : "fault"} title={result.ok ? undefined : "The download didn't finish"}>
                {result.message}
              </Notice>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
