"use client";
import * as React from "react";
import type { JobEvent } from "@/lib/builder-types";
import type { ChatCallsStatus } from "@/lib/chat-types";
import { api, ApiError, streamPost, useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import { JobProgress } from "@/components/builder/JobProgress";
import { emptyJob, reduceJob, type JobView } from "@/components/builder/state";
import s from "./chat.module.css";

const STAGES = [
  { key: "check", label: "Check" },
  { key: "write", label: "Write files" },
  { key: "start", label: "Start" },
  { key: "run", label: "Running" },
];

/** What the router has to forward, with copy buttons: the part people get wrong. */
function Forwarding({ st }: { st: ChatCallsStatus }) {
  const to = st.lanIp ?? "this server";
  const rows = [
    { what: `UDP and TCP ${st.ports.turn}`, why: "Chat apps ask the relay for a route" },
    { what: `UDP ${st.ports.relayMin}-${st.ports.relayMax}`, why: "The calls themselves" },
  ];
  return (
    <div className={s.form}>
      <p className={s.hint}>
        In your router{st.gateway ? ` (usually at http://${st.gateway})` : ""}, forward these to <span className="mono">{to}</span>:
      </p>
      <dl className={s.creds}>
        {rows.map((r) => (
          <div key={r.what} className={s.cred}>
            <dt>{r.why}</dt>
            <dd>
              <span className={s.credValue}>{r.what}</span>
              <CopyButton value={r.what} size="sm" label={`Copy ${r.what}`} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Checks({ st }: { st: ChatCallsStatus }) {
  const line = (ok: boolean | null, yes: string, no: string, unknown: string) =>
    ok === null ? <StateLine state="unknown" label={unknown} /> : ok ? <StateLine state="running" label={yes} /> : <StateLine state="unhealthy" label={no} />;
  return (
    <dl className={s.facts2}>
      <div>
        <dt>Relay</dt>
        <dd>{!st.relay ? <StateLine state="stopped" label="Not installed" /> : st.relay.running ? <StateLine state="running" label={`${st.relay.name} is running`} /> : <StateLine state="unhealthy" label={`${st.relay.name} is stopped`} />}</dd>
      </div>
      <div>
        <dt>On this server</dt>
        <dd>{line(st.answers.here, `Answers on ${st.ports.turn}`, `Not answering on ${st.ports.turn}`, "Gluon checks this when it runs on the server")}</dd>
      </div>
      <div>
        <dt>From outside</dt>
        <dd>{line(st.answers.outside, "Your router passes it on", `Your router isn't forwarding UDP ${st.ports.turn}`, "Gluon checks this when it runs on the server")}</dd>
      </div>
    </dl>
  );
}

/**
 * Calls across networks: installs a small TURN relay (coturn) next to Prosody and turns on the
 * setting that hands chat apps logins for it. Says exactly what the router has to forward.
 */
export function CallsDialog({ open, onOpenChange, appId, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; onChanged: () => void }) {
  const url = `/api/chat/${encodeURIComponent(appId)}/calls`;
  const { data: st, mutate } = useApi<ChatCallsStatus>(open ? url : null);
  const [busy, setBusy] = React.useState(false);
  const [job, setJob] = React.useState<JobView | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  React.useEffect(() => {
    if (open) {
      setJob(null);
      setFailure(null);
    }
  }, [open]);

  async function setUp() {
    setBusy(true);
    setFailure(null);
    try {
      const { draftId } = await api.post<{ draftId: string | null }>(url, {});
      if (draftId) {
        setJob(emptyJob);
        let ok = false;
        await streamPost<JobEvent>(`/api/custom-apps/${draftId}/publish`, {}, (ev) => {
          setJob((v) => reduceJob(v ?? emptyJob, ev));
          if (ev.type === "done") ok = !!ev.ok;
        });
        if (!ok) throw new Error("The relay didn't start. The steps above say where it stopped.");
      }
      const r = await api.post<{ notes: string[] }>(`${url}/finish`, { draftId });
      toast.success("Calls are on", r.notes.length ? { description: r.notes.join(" ") } : { description: "Chat apps pick up the relay the next time they connect." });
      await mutate();
      onChanged();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setFailure(e instanceof Error ? e.message : "Calls weren't set up.");
    } finally {
      setBusy(false);
    }
  }

  const turnOff = () =>
    confirm({
      title: "Turn off calls across networks?",
      consequences: ["Calls on the same network keep working.", "Calls between two homes or on mobile data may fail again.", "The Call relay app stays installed; remove it from Apps if you don't want it."],
      confirmLabel: "Turn off",
      onConfirm: async () => {
        await api.del(url);
        toast.success("Calls across networks are off");
        await mutate();
        onChanged();
      },
    });

  const on = !!st?.on;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size="wide"
      title={on ? "Calls across networks" : "Make calls work everywhere"}
      description={on ? undefined : "Two phones on different networks often can't reach each other directly. A small relay on this server carries the call between them."}
      footer={
        on ? (
          <>
            <Button variant="ghost" onClick={turnOff} disabled={busy}>
              Turn off
            </Button>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!st} onClick={() => void setUp()}>
              {st?.relay ? "Turn on calls" : "Set up calls"}
            </Button>
          </>
        )
      }
    >
      {!st ? (
        <Skeleton height={220} radius={10} />
      ) : (
        <div className={s.form}>
          {!on && (
            <p className={s.hint}>
              {st.relay
                ? `Gluon gives chat apps logins for ${st.relay.name}, which is already on this server.`
                : "Gluon installs coturn as an app called Call relay. It only relays calls to the internet, never into your home network, and chat apps get logins that expire."}
            </p>
          )}
          {job && <JobProgress view={job} stages={STAGES} running={busy} label="Installing the call relay" closeNote="Keep this open: once the relay runs, Gluon gives Prosody its secret." />}
          {failure && (
            <Notice tone="fault" title="Calls weren't set up">
              {failure}
            </Notice>
          )}
          {(on || st.relay) && <Checks st={st} />}
          <Forwarding st={st} />
        </div>
      )}
      {confirmNode}
    </Dialog>
  );
}
