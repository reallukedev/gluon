"use client";
import * as React from "react";
import type { VoiceDetails, VoiceSetting } from "@/server/voice/types";
import { Button } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Segmented, Switch, TextArea } from "@/components/ui/Field";
import { Panel, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { JobProgress } from "@/components/builder/JobProgress";
import { api, ApiError } from "@/lib/client/api";
import { act, people, quiet, useVoiceJob, voiceUrl } from "./client";
import { looksLikeHtml, previewHtml } from "./richtext";
import s from "./voice.module.css";

const shown = (st: VoiceSetting) => (st.scale ? String(Math.round(Number(st.value) / st.scale)) : st.value);

/**
 * Mumble's common settings, applied live through Ice (no restart). Edits collect in a save bar.
 * Each says where its value comes from when the compose file is involved, because a value set
 * here wins over the file's until it's cleared.
 */
export function VoiceSettings({ appId, appName, details, connected, via, onChanged }: { appId: string; appName: string; details: VoiceDetails | null; connected: number; via: "builder" | "compose" | null; onChanged: () => void }) {
  const where = via === "builder" ? "the app's builder settings" : "the compose file";
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const list = details?.settings ?? null;

  const dirtyKeys = list ? Object.keys(draft).filter((k) => list.find((x) => x.key === k) && draft[k] !== shown(list.find((x) => x.key === k)!)) : [];

  async function save() {
    if (!list) return;
    setSaving(true);
    const errs: Record<string, string> = {};
    let saved = 0;
    for (const key of dirtyKeys) {
      try {
        await api.post(voiceUrl(appId, "/act"), { op: "setting", key, value: draft[key] });
        saved++;
      } catch (e) {
        if (quiet(e)) break;
        errs[key] = e instanceof Error ? e.message : "Couldn't save this.";
      }
    }
    setErrors(errs);
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => errs[k])));
    setSaving(false);
    if (saved) {
      toast.success(saved === 1 ? "Saved. Mumble uses it now." : `Saved ${saved} settings. Mumble uses them now.`);
      onChanged();
    }
  }

  if (!list) {
    return (
      <Panel title="Settings">
        <div className={s.dialogStack} aria-busy="true">
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={120} />
        </div>
      </Panel>
    );
  }

  const value = (st: VoiceSetting) => draft[st.key] ?? shown(st);
  const set = (key: string, v: string) => {
    setDraft((d) => ({ ...d, [key]: v }));
    setErrors((e) => ({ ...e, [key]: "" }));
  };
  const byKey = (k: string) => list.find((x) => x.key === k);
  const order = ["registername", "welcometext", "password", "users", "usersperchannel", "bandwidth", "allowhtml", "rememberchannel", "allowrecording", "certrequired", "textmessagelength", "imagemessagelength"];

  return (
    <>
      <Panel title="Settings" meta={<span className={s.hint}>No restart needed</span>} flush>
        <div className={s.settings}>
          {order.map((k) => {
            const st = byKey(k);
            if (!st) return null;
            if (st.key === "password") return <PasswordRow key={k} appId={appId} appName={appName} st={st} connected={connected} where={where} onChanged={onChanged} />;
            return <SettingRow key={k} appId={appId} st={st} where={where} value={value(st)} error={errors[st.key] || null} onChange={(v) => set(st.key, v)} onChanged={onChanged} />;
          })}
        </div>
      </Panel>
      {dirtyKeys.length > 0 && (
        <div className={s.saveBar} role="region" aria-label="Unsaved settings">
          <p>{dirtyKeys.length === 1 ? "1 setting changed." : `${dirtyKeys.length} settings changed.`}</p>
          <div className={s.saveActions}>
            <Button variant="ghost" onClick={() => setDraft({})} disabled={saving}>
              Undo
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </div>
        </div>
      )}
      {details?.notes.map((n) => (
        <p key={n} className={s.hint}>
          {n}
        </p>
      ))}
    </>
  );
}

function Source({ appId, st, where, onChanged }: { appId: string; st: VoiceSetting; where: string; onChanged: () => void }) {
  if (st.source === "default") return null;
  if (st.source === "compose") {
    return (
      <p className={s.source}>
        <span>
          From {where}, <code>{st.envName}</code>
        </span>
      </p>
    );
  }
  const show = (v: string) => (st.kind === "bool" ? (v === "true" ? "on" : "off") : st.kind === "secret" ? "its own password" : st.kind === "richtext" ? "its own message" : `${st.scale ? Math.round(Number(v) / st.scale) : v}${st.unit ? ` ${st.unit}` : ""}`);
  if (!st.envName) {
    return (
      <p className={s.source}>
        <span>{st.fallback === "" ? "Set here. Mumble leaves it empty by default." : `Set here. Mumble's default is ${show(st.fallback)}.`}</span>
        <button type="button" className={s.linkButton} onClick={() => void act(appId, { op: "setting.reset", key: st.key }).then((ok) => ok && onChanged())}>
          Go back to that
        </button>
      </p>
    );
  }
  const fileValue = show(st.envValue ?? "");
  return (
    <p className={s.source}>
      <span>
        Set here. <code>{st.envName}</code> in {where} has {fileValue || "nothing"}.
      </span>
      <button type="button" className={s.linkButton} onClick={() => void act(appId, { op: "setting.reset", key: st.key }).then((ok) => ok && onChanged())}>
        Go back to that
      </button>
    </p>
  );
}

function SettingRow({ appId, st, where, value, error, onChange, onChanged }: { appId: string; st: VoiceSetting; where: string; value: string; error: string | null; onChange: (v: string) => void; onChanged: () => void }) {
  const id = React.useId();
  const text = (
    <div className={s.settingText}>
      <label className={s.settingTitle} htmlFor={id}>
        {st.label}
      </label>
      <p className={s.settingDesc} id={`${id}-d`}>
        {st.help}
      </p>
      <Source appId={appId} st={st} where={where} onChanged={onChanged} />
      {error && (
        <p className={s.source} role="alert" style={{ color: "var(--fault)" }}>
          {error}
        </p>
      )}
    </div>
  );
  if (st.kind === "richtext") return <WelcomeRow id={id} text={text} value={value} onChange={onChange} />;
  return (
    <div className={s.setting}>
      {text}
      <div className={s.settingControl}>
        {st.kind === "bool" ? (
          <Switch id={id} checked={value === "true"} onChange={(v) => onChange(String(v))} aria-describedby={`${id}-d`} />
        ) : st.kind === "number" ? (
          st.unit ? (
            <AffixInput id={id} className={s.numberInput} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))} after={st.unit} aria-describedby={`${id}-d`} aria-invalid={!!error || undefined} />
          ) : (
            <Input id={id} className={s.numberInput} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))} aria-describedby={`${id}-d`} aria-invalid={!!error || undefined} />
          )
        ) : (
          <Input id={id} className={s.textInput} value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} placeholder="Uses the channel name Root" aria-describedby={`${id}-d`} aria-invalid={!!error || undefined} />
        )}
      </div>
    </div>
  );
}

function WelcomeRow({ id, text, value, onChange }: { id: string; text: React.ReactNode; value: string; onChange: (v: string) => void }) {
  const [mode, setMode] = React.useState<"write" | "preview">("write");
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (mode !== "preview" || !el) return;
    el.replaceChildren(looksLikeHtml(value) ? previewHtml(value) : document.createTextNode(value));
    el.style.whiteSpace = looksLikeHtml(value) ? "normal" : "pre-wrap";
  }, [mode, value]);
  return (
    <div className={s.setting}>
      {text}
      <div className={s.wide}>
        <div className={s.welcomeTabs}>
          <Segmented aria-label="Welcome message view" value={mode} onChange={setMode} options={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]} />
        </div>
        {mode === "write" ? (
          <TextArea id={id} className={s.welcomeArea} value={value} onChange={(e) => onChange(e.target.value)} rows={5} maxLength={20_000} spellCheck />
        ) : value.trim() ? (
          <div ref={ref} className={s.preview} aria-label="Preview of the welcome message" />
        ) : (
          <div className={`${s.preview} ${s.previewEmpty}`}>No welcome message. People join without one.</div>
        )}
      </div>
    </div>
  );
}

/** The join password: shown masked, changed live, or removed (from the compose file too, when it sets one). */
function PasswordRow({ appId, appName, st, connected, where, onChanged }: { appId: string; appName: string; st: VoiceSetting; connected: number; where: string; onChanged: () => void }) {
  const [reveal, setReveal] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const job = useVoiceJob(onChanged);
  const has = st.value !== "";
  const fromFile = !!st.envValue;

  const remove = () => {
    if (!fromFile) {
      confirm({
        title: "Remove the join password?",
        consequences: ["Anyone with the address can join from now on.", "People already connected stay connected."],
        confirmLabel: "Remove the password",
        variant: "danger",
        onConfirm: async () => {
          if (await act(appId, { op: "setting.reset", key: "password" })) onChanged();
        },
      });
      return;
    }
    confirm({
      title: "Remove the join password?",
      description: `It's set in ${where} (${st.envName}), so Gluon takes it out there and restarts ${appName}.`,
      consequences: [
        "Anyone with the address can join from now on.",
        connected ? `${people(connected)} connected now ${connected === 1 ? "drops" : "drop"} for a few seconds, then reconnect${connected === 1 ? "s" : ""} on their own.` : "Nobody is connected, so nobody notices the restart.",
        where === "the compose file" ? "Gluon backs up the file first and puts it back if Mumble doesn't start." : "Gluon publishes the app again with the change.",
      ],
      confirmLabel: "Remove and restart",
      variant: "danger",
      onConfirm: () => {
        setRemoving(true);
        void job.start(voiceUrl(appId, "/password"));
      },
    });
  };

  return (
    <div className={s.setting}>
      <div className={s.settingText}>
        <span className={s.settingTitle}>{st.label}</span>
        <p className={s.settingDesc}>{has ? st.help : "None. Anyone with the address can join."}</p>
        {st.source === "compose" && (
          <p className={s.source}>
            <span>
              From {where}, <code>{st.envName}</code>
            </span>
          </p>
        )}
        {st.source === "gluon" && fromFile && (
          <p className={s.source}>
            <span>Set here. {where === "the compose file" ? "The compose file" : "The app's builder settings"} has a different one, which comes back if this is removed here only.</span>
          </p>
        )}
      </div>
      <div className={s.secret}>
        {has && (
          <>
            <span className={s.secretValue} aria-label={reveal ? "Join password" : "Join password, hidden"}>
              {reveal ? st.value : "••••••••"}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
              {reveal ? "Hide" : "Show"}
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => setChanging(true)}>
          {has ? "Change…" : "Set a password…"}
        </Button>
        {has && (
          <Button size="sm" variant="danger" onClick={remove}>
            Remove the password
          </Button>
        )}
      </div>
      <PasswordDialog appId={appId} open={changing} onOpenChange={setChanging} onDone={onChanged} has={has} />
      <Dialog
        open={removing}
        onOpenChange={(o) => {
          if (!o && !job.running) {
            setRemoving(false);
            job.reset();
          }
        }}
        title="Removing the join password"
        footer={
          <Button variant={job.running ? "ghost" : "primary"} onClick={() => setRemoving(false)} disabled={job.running}>
            {job.running ? "Working…" : "Done"}
          </Button>
        }
      >
        {job.error ? <p role="alert">{job.error}</p> : job.view ? <JobProgress view={job.view} stages={job.view.stages} running={job.running} label="Removing the join password" /> : null}
      </Dialog>
      {confirmNode}
    </div>
  );
}

function PasswordDialog({ appId, open, onOpenChange, onDone, has }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void; has: boolean }) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
    }
  }, [open]);
  async function save() {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      if (await act(appId, { op: "setting", key: "password", value }, { inline: true })) {
        onDone();
        onOpenChange(false);
      }
    } catch (e) {
      if (!quiet(e)) setError(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={has ? "Change the join password" : "Set a join password"}
      description="Everyone without a registered name types it when they connect. People already connected stay connected."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!value} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Password" error={error}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={128} autoFocus autoComplete="off" spellCheck={false} />
        </Field>
      </form>
    </Dialog>
  );
}
