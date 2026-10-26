"use client";
import * as React from "react";
import { ClockRotateRight } from "iconoir-react";
import type { ComposeFile, ValidationResult } from "@/server/docker/compose";
import { api, streamPost, useApi, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Segmented } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { StreamDialog, emptyStream, reduceStream, type StreamEvent, type StreamState } from "@/components/ui/StreamLog";
import { CodeEditor } from "@/components/code/CodeEditor";
import s from "./compose.module.css";

export function ComposeEditor({ appId, onApplied }: { appId: string; onApplied: () => void }) {
  const fmt = useFormat();
  const url = `/api/apps/${encodeURIComponent(appId)}/compose`;
  const { data, error, mutate } = useApi<ComposeFile>(url, { revalidateOnFocus: false });
  const [text, setText] = React.useState<string | null>(null);
  const [view, setView] = React.useState<"edit" | "changes">("edit");
  const [check, setCheck] = React.useState<ValidationResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [stream, setStream] = React.useState<StreamState>(emptyStream);
  const [streamOpen, setStreamOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  React.useEffect(() => {
    if (data && text === null) setText(data.content);
  }, [data, text]);

  // Warn before leaving with unsaved edits.
  const dirty = data !== undefined && text !== null && text !== data.content;
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const deferred = React.useDeferredValue(text);
  const changes = React.useMemo(() => (data && deferred !== null && deferred !== data.content ? lineChanges(data.content, deferred) : null), [data, deferred]);

  if (error) return <Notice tone="fault" title="Couldn't open the compose file">{error.message}</Notice>;
  if (!data || text === null) return <Skeleton height={480} radius={12} />;

  async function validate() {
    setChecking(true);
    try {
      setCheck(await api.post<ValidationResult>(`${url}/validate`, { content: text }));
    } catch (e) {
      setCheck({ ok: false, message: e instanceof Error ? e.message : "Couldn't check the file." });
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    setStream(emptyStream);
    setStreamOpen(true);
    setRunning(true);
    try {
      await streamPost<StreamEvent>(`${url}/apply`, { content: text, hash: data!.hash }, (e) => setStream((st) => reduceStream(st, e)));
      const fresh = await mutate();
      if (fresh) setText(fresh.content);
      onApplied();
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") {
        setStreamOpen(false);
      } else {
        setStream((st) => reduceStream(st, { type: "error", message: e instanceof Error ? e.message : "Couldn't apply the change." }));
      }
    } finally {
      setRunning(false);
    }
  }

  /** Apply only what Compose accepts: check first, and show the problem instead of the confirmation. */
  async function checkThenConfirm() {
    setChecking(true);
    let result: ValidationResult;
    try {
      result = await api.post<ValidationResult>(`${url}/validate`, { content: text });
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : "Couldn't check the file." };
    } finally {
      setChecking(false);
    }
    setCheck(result);
    if (!result.ok) return;
    confirm({
      title: "Apply this change?",
      consequences: [
        changes ? `${fmt.plural(changes.added, "line")} added and ${fmt.plural(changes.removed, "line")} removed. The current file is backed up first.` : "The current file is backed up first.",
        `Compose recreates any container whose settings changed${result.services?.length ? ` (of ${result.services.join(", ")})` : ""}. Those are offline for a few seconds.`,
        "If the new version doesn't start, Gluon puts the previous one back and starts it.",
      ],
      confirmLabel: "Apply",
      variant: "primary",
      onConfirm: async () => void apply(),
    });
  }

  async function loadBackup(name: string) {
    try {
      const r = await api.get<{ content: string }>(`${url}/backup?name=${encodeURIComponent(name)}`);
      setText(r.content);
      setView("changes");
      toast.info("Loaded the backup into the editor", { description: "Review the changes, then apply to restore it." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open that backup.");
    }
  }

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <span className={`${s.path} mono`} title={data.path}>
          {data.path}
        </span>
        {dirty && (
          <span className={s.dirty}>
            Not applied yet
            {changes && (
              <span className={`${s.delta} num`}>
                +{changes.added} −{changes.removed}
              </span>
            )}
          </span>
        )}
        <span className={s.spacer} />
        <Segmented
          aria-label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "edit", label: "Edit" },
            { value: "changes", label: dirty ? "Changes" : "Changes (none)" },
          ]}
        />
        {data.backups.length > 0 && (
          <Menu
            trigger={
              <Button variant="ghost" icon={<ClockRotateRight />}>
                Earlier versions
              </Button>
            }
            items={data.backups.slice(0, 10).map((b) => ({ label: fmt.dateTime(b.at), description: "Load into the editor to review", onSelect: () => void loadBackup(b.name) }))}
          />
        )}
      </div>

      {view === "edit" ? (
        <CodeEditor value={text} onChange={(v) => {
          setText(v);
          setCheck(null);
        }} language="yaml" label="Compose file" height="min(64dvh, 640px)" />
      ) : (
        <CodeEditor key="diff" value={text} original={data.content} language="yaml" readOnly label="Changes to the compose file" height="min(64dvh, 640px)" />
      )}

      {check && (
        <Notice tone={check.ok ? "neutral" : "fault"} title={check.ok ? "The file is valid" : "Compose can't use this file yet"}>
          {check.ok ? `Services: ${check.services?.join(", ")}.` : <span className="mono" style={{ whiteSpace: "pre-wrap" }}>{check.message}</span>}
        </Notice>
      )}

      <div className={s.actions}>
        <p className={s.note}>Applying saves a backup first. If the app doesn't start with your change, Gluon puts the previous version back automatically.</p>
        <Button variant="ghost" disabled={!dirty} onClick={() => {
          setText(data.content);
          setCheck(null);
        }}>
          Discard changes
        </Button>
        <Button loading={checking} onClick={() => void validate()}>
          Check
        </Button>
        <Button
          variant="primary"
          disabled={!dirty}
          loading={checking}
          onClick={() => void checkThenConfirm()}
        >
          Apply
        </Button>
      </div>

      <StreamDialog open={streamOpen} onClose={() => setStreamOpen(false)} title="Applying the compose file" state={stream} running={running} />
      {confirmNode}
    </div>
  );
}

/** Lines added and removed, counted as multisets: enough for a "+3 −1" summary. */
function lineChanges(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of before.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}
