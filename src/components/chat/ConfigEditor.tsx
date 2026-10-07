"use client";
import * as React from "react";
import { api, ApiError, useApi } from "@/lib/client/api";
import { CodeEditor } from "@/components/code/CodeEditor";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import s from "./chat.module.css";

interface Files {
  main: string;
  gluon: string | null;
  file: string;
  writable: boolean;
  reason: string | null;
}
interface Check {
  ok: boolean;
  line: number | null;
  message: string;
  output: string;
}

/**
 * Prosody's own config file, for anything Gluon's settings don't cover. Prosody checks every
 * change before it's saved, and the file Gluon manages is shown read-only beside it.
 */
export function ConfigEditor({ appId, onSaved }: { appId: string; onSaved: () => void }) {
  const url = `/api/chat/${encodeURIComponent(appId)}/config`;
  const { data, error, mutate } = useApi<Files>(url);
  const [text, setText] = React.useState<string | null>(null);
  const [check, setCheck] = React.useState<Check | null>(null);
  const [busy, setBusy] = React.useState<"check" | "save" | "restart" | null>(null);

  React.useEffect(() => {
    if (data && text === null) setText(data.main);
  }, [data, text]);

  if (error) return <Notice tone="fault" title="Gluon couldn't read the config file">{error.message}</Notice>;
  if (!data || text === null) return <Skeleton height={360} radius={0} />;
  const changed = text !== data.main;

  async function run(kind: "check" | "save" | "restart") {
    setBusy(kind);
    setCheck(null);
    try {
      if (kind === "check") {
        setCheck(await api.post<Check>(url, { text }));
        return;
      }
      const r = await api.put<{ saved: boolean; check: Check; restarted?: boolean }>(url, { text, base: data!.main, restart: kind === "restart" });
      setCheck(r.check);
      if (r.saved) {
        toast.success(r.restarted ? "Saved, and Prosody restarted" : "Saved, and Prosody reloaded it");
        await mutate();
        setText(null);
        onSaved();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      toast.error(kind === "check" ? "Couldn't check the config" : "The config wasn't saved", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className={s.configBar}>
        <p className="mono">{data.file}</p>
        <div className={s.configActions}>
          {changed && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => (setText(data.main), setCheck(null))}>
              Undo changes
            </Button>
          )}
          <Button size="sm" disabled={!changed || !!busy} loading={busy === "check"} onClick={() => void run("check")}>
            Check
          </Button>
          <Button size="sm" disabled={!changed || !!busy || !data.writable} loading={busy === "restart"} onClick={() => void run("restart")} title="Needed for new chat domains, ports or services">
            Save and restart
          </Button>
          <Button size="sm" variant="primary" disabled={!changed || !!busy || !data.writable} loading={busy === "save"} onClick={() => void run("save")}>
            Save and reload
          </Button>
        </div>
      </div>
      <div className={s.configEditor}>
        <CodeEditor value={text} onChange={setText} language="lua" height={420} label="Prosody config file" readOnly={!data.writable} />
      </div>
      {check && (
        <div className={s.configResult} role="status">
          {check.ok ? (
            <Notice title={check.message}>Prosody read the whole file without errors.</Notice>
          ) : (
            <Notice tone="fault" title={check.line ? `Line ${check.line}: ${check.message}` : check.message}>
              Nothing was saved. Fix it and check again.
            </Notice>
          )}
        </div>
      )}
      {data.gluon && (
        <div className={s.configResult}>
          <Disclosure summary="The settings file Gluon writes (gluon.cfg.lua)" meta="read-only">
            <CodeEditor value={data.gluon} language="lua" readOnly height={260} label="Gluon's settings file" />
          </Disclosure>
        </div>
      )}
    </>
  );
}
