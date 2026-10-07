"use client";
import * as React from "react";
import type { VoiceDetails } from "@/server/voice/types";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { useFormat } from "@/components/PrefsProvider";
import { quiet, voiceUrl } from "./client";
import s from "./voice.module.css";

const OFF = "__off__";
const DAY = 86_400_000;

/**
 * What certificate Mumble presents, and the switch that keeps it current from one Caddy already
 * has for a public address.
 */
export function Certificate({ appId, details, onChanged }: { appId: string; details: VoiceDetails | null; onChanged: () => void }) {
  const fmt = useFormat();
  const [busy, setBusy] = React.useState<"choose" | "check" | null>(null);
  const c = details?.cert ?? null;

  async function run(kind: "choose" | "check", req: () => Promise<{ ok: boolean; message: string }>, done = "Certificate checked") {
    setBusy(kind);
    try {
      const r = await req();
      if (r.message) (r.ok ? toast.success : toast.attention)(r.ok ? done : "Check Mumble's certificate", { description: r.message });
      onChanged();
    } catch (e) {
      if (!quiet(e)) toast.error("That didn't work", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  if (!c) {
    return (
      <Panel title="Certificate">
        <Skeleton height={60} />
      </Panel>
    );
  }

  const served = c.served;
  const days = served?.notAfter ? Math.floor((served.notAfter - Date.now()) / DAY) : null;
  const now = !served ? (
    <>Gluon couldn&rsquo;t read the certificate Mumble presents.</>
  ) : served.selfSigned ? (
    <>Mumble uses a self-signed certificate, so Mumble apps ask people to trust it the first time they connect.</>
  ) : (
    <>
      Mumble presents a certificate for <b>{served.subject ?? "this server"}</b>
      {served.issuer ? ` from ${served.issuer}` : ""}
      {served.notAfter ? `, valid until ${fmt.date(served.notAfter, { year: true })}` : ""}.
    </>
  );
  const state = !served ? "unknown" : served.selfSigned || (days !== null && days < 21) ? "attention" : "running";
  const choices = [{ value: OFF, label: "Don't keep it current" }, ...c.choices.map((d) => ({ value: d, label: d }))];

  return (
    <Panel title="Certificate">
      <div className={s.cert}>
        <div className={s.certNow}>
          <span className={s.certLine}>
            <StateLine state={state} />
          </span>
          <p className={s.certTitle}>{now}</p>
          {served?.fingerprint && <p className={`${s.certMeta} mono`}>SHA-256 {served.fingerprint.slice(0, 23)}…</p>}
        </div>

        <p className={s.hint}>
          Gluon can copy the certificate Caddy already keeps for one of your addresses into Mumble{c.folder ? <> (and into <span className="mono">{c.folder}</span>)</> : null}, and loads it without a restart. It copies it when Mumble&rsquo;s is missing, untrusted or within 21 days of expiring, and checks every few hours. People already connected keep the old one until they reconnect.
        </p>

        {c.blocked ? (
          <p className={s.hint}>{c.blocked}</p>
        ) : (
          <div className={s.certControls}>
            <Field label="Keep it current from" className={s.certSelect}>
              <Select
                aria-label="Keep it current from"
                value={c.domain ?? OFF}
                disabled={busy !== null || c.choices.length === 0}
                onChange={(v) => void run("choose", () => api.put(voiceUrl(appId, "/certificate"), { domain: v === OFF ? null : v }), v === OFF ? "Stopped keeping it current" : `Following ${v}`)}
                options={choices}
              />
            </Field>
            {c.domain && (
              <Button loading={busy === "check"} disabled={busy !== null} onClick={() => void run("check", () => api.post(voiceUrl(appId, "/certificate"), {}))}>
                Check now
              </Button>
            )}
          </div>
        )}
        {c.choices.length === 0 && !c.blocked && <p className={s.hint}>None of your public addresses has a certificate Mumble could use. Add one in Network first, like voice.example.com.</p>}

        {c.domain && c.sync && (
          <div className={s.certNow}>
            <span className={s.certLine}>
              <StateLine state={c.sync.ok ? "running" : "attention"} />
            </span>
            <p className={s.certTitle}>{c.sync.message}</p>
            {c.sync.checkedAt && (
              <p className={s.certMeta}>
                Checked <Time ts={c.sync.checkedAt} />
                {c.sync.copiedAt ? (
                  <>
                    , last copied <Time ts={c.sync.copiedAt} />
                  </>
                ) : null}
              </p>
            )}
          </div>
        )}
        {c.folder && !c.writable && c.domain && <p className={s.hint}>Gluon can&rsquo;t write to {c.folder}, so it only gives Mumble the certificate over its admin connection.</p>}
      </div>
    </Panel>
  );
}
