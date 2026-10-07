"use client";
import * as React from "react";
import type { JobEvent } from "@/lib/builder-types";
import type { InstallDefaults } from "@/server/voice/types";
import { api, ApiError, streamPost, useApi } from "@/lib/client/api";
import { Button, LinkButton, buttonClass } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, TextArea } from "@/components/ui/Field";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Notice } from "@/components/ui/Surface";
import { JobProgress } from "@/components/builder/JobProgress";
import { emptyJob, reduceJob, type JobView } from "@/components/builder/state";
import s from "./voice.module.css";

type Step = "name" | "password" | "port" | "review" | "install" | "ready";
const STEPS: { key: Step; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "password", label: "Password" },
  { key: "port", label: "Port" },
  { key: "review", label: "Review" },
  { key: "install", label: "Install" },
  { key: "ready", label: "Ready" },
];
const JOB_STAGES = [
  { key: "check", label: "Check" },
  { key: "write", label: "Write files" },
  { key: "start", label: "Start" },
  { key: "run", label: "Running" },
];

interface Done {
  appId: string;
  name: string;
  host: string;
  port: number;
  link: string;
  superuser: string;
}

/**
 * A new Mumble voice server with Gluon managing it from the first start: name and welcome message,
 * an optional join password, the port, then the builder installs it and Gluon sets a random admin
 * password, shown here once with everything people need to connect.
 */
export function VoiceInstallFlow({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: plan, error: planError } = useApi<InstallDefaults>(open ? "/api/voice/install" : null, { revalidateOnFocus: false });
  const [step, setStep] = React.useState<Step>("name");
  const [name, setName] = React.useState("");
  const [welcome, setWelcome] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [port, setPort] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<JobView>(emptyJob);
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState<Done | null>(null);
  const abort = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep("name");
    setPassword("");
    setErrors({});
    setFailure(null);
    setJob(emptyJob);
    setDone(null);
  }, [open]);
  // Fill the starting values once they arrive, without overwriting what's been typed.
  React.useEffect(() => {
    if (!open || !plan) return;
    setName((v) => v || plan.name);
    setWelcome((v) => v || plan.welcome);
    setPort((v) => v || String(plan.port));
  }, [open, plan]);
  React.useEffect(() => () => abort.current?.abort(), []);

  const portNum = Number(port);
  const portTaken = plan?.taken.filter((t) => t.port === portNum) ?? [];

  function check(at: Step): boolean {
    const e: Record<string, string> = {};
    if (at === "name" && !name.trim()) e.name = "Give it a name.";
    if (at === "password" && /[\r\n]/.test(password)) e.password = "Keep the password on one line.";
    if (at === "port") {
      if (!/^\d+$/.test(port) || portNum < 1024 || portNum > 65535) e.port = "Use a port from 1024 to 65535.";
      else if (portTaken.length) e.port = `Port ${portNum} is already used by ${portTaken[0]!.by}. Pick another one.`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function install() {
    setStep("install");
    setRunning(true);
    setFailure(null);
    setJob(emptyJob);
    abort.current = new AbortController();
    try {
      const { draftId } = await api.post<{ draftId: string; appId: string }>("/api/voice/install", { name: name.trim(), welcome, password, port: portNum });
      let ok = false;
      await streamPost<JobEvent>(
        `/api/custom-apps/${draftId}/publish`,
        {},
        (ev) => {
          setJob((v) => reduceJob(v, ev));
          if (ev.type === "done") ok = !!ev.ok;
        },
        abort.current.signal,
      );
      if (!ok) throw new Error("The install didn't finish. The steps above say where it stopped.");
      setJob((v) => ({ ...v, result: { ok: true, message: "Mumble is running. Giving it an admin password…" } }));
      const r = await api.post<Done>("/api/voice/install/finish", { draftId });
      setDone(r);
      setStep("ready");
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") {
        setStep("review");
        return;
      }
      if (e instanceof ApiError && e.field) {
        setErrors({ [e.field]: e.message });
        setStep(e.field === "port" ? "port" : e.field === "password" ? "password" : "name");
        return;
      }
      setFailure(e instanceof Error ? e.message : "The voice server wasn't set up.");
    } finally {
      setRunning(false);
    }
  }

  const idx = STEPS.findIndex((x) => x.key === step);
  const next = () => {
    if (step === "name" && check("name")) setStep("password");
    else if (step === "password" && check("password")) setStep("port");
    else if (step === "port" && check("port")) setStep("review");
    else if (step === "review") void install();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    next();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      size="wide"
      title={step === "ready" ? "Your voice server is ready" : "Set up a voice server"}
      description={step === "ready" ? undefined : "Mumble: low-latency group voice chat with apps for every computer and phone. Gluon manages it from the first start."}
      footer={
        step === "ready" && done ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <LinkButton variant="primary" href={`/apps/${encodeURIComponent(done.appId)}?tab=voice`} onClick={() => onOpenChange(false)}>
              Manage the voice server
            </LinkButton>
          </>
        ) : step === "install" ? (
          failure ? (
            <Button variant="primary" onClick={() => setStep("review")}>
              Back
            </Button>
          ) : (
            <Button variant="primary" loading disabled>
              Installing
            </Button>
          )
        ) : (
          <>
            {idx > 0 ? (
              <Button variant="ghost" onClick={() => setStep(STEPS[idx - 1]!.key)}>
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button variant="primary" disabled={!plan} onClick={next}>
              {step === "review" ? "Install" : "Continue"}
            </Button>
          </>
        )
      }
    >
      <div className={s.steps}>
        <FlowSteps label="Setting up a voice server" steps={STEPS} current={step} working={running} failed={!!failure} complete={step === "ready"} />
        {planError && <Notice tone="fault" title="Gluon couldn't check this server">{planError.message}</Notice>}

        {step === "name" && (
          <form className={s.steps} onSubmit={submit}>
            <Field label="Name" error={errors.name} description="Shown at the top of the channel list, and as the app's name in Gluon.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="Mumble" />
            </Field>
            <Field label="Welcome message" optional error={errors.welcome} description="What people see in the chat when they join. Simple HTML works, like <b>bold</b>. You can change it any time.">
              <TextArea value={welcome} onChange={(e) => setWelcome(e.target.value)} rows={3} maxLength={5000} />
            </Field>
            <button type="submit" hidden />
          </form>
        )}

        {step === "password" && (
          <form className={s.steps} onSubmit={submit}>
            <Field label="Join password" optional error={errors.password} description="Leave it empty so anyone with the address can join. With one, people type it once and their Mumble app remembers it.">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} autoFocus autoComplete="off" spellCheck={false} />
            </Field>
            <button type="submit" hidden />
          </form>
        )}

        {step === "port" && (
          <form className={s.steps} onSubmit={submit}>
            <Field label="Port" error={errors.port} description={portNum === 64738 ? "Mumble's usual port, so people only need the address." : "People add this port after the address, like voice.example.com:" + (port || "64739") + "."}>
              <Input mono className={s.portInput} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))} autoFocus maxLength={5} />
            </Field>
            <p className={s.hint}>Mumble uses it for both TCP and UDP. To join from outside your home, forward both on your router to this server.</p>
            <button type="submit" hidden />
          </form>
        )}

        {step === "review" && (
          <dl className={s.review}>
            <dt>Name</dt>
            <dd>{name.trim()}</dd>
            <dt>Welcome message</dt>
            <dd>{welcome.trim() || "None"}</dd>
            <dt>Join password</dt>
            <dd>{password ? "Set" : "None, anyone with the address can join"}</dd>
            <dt>Port</dt>
            <dd>
              <span className="mono">{port}</span>, TCP and UDP
            </dd>
            <dt>Runs as</dt>
            <dd>An app made with Gluon&rsquo;s builder, Mumble 1.5.915, its data in the app&rsquo;s own folder</dd>
          </dl>
        )}

        {step === "install" && (
          <>
            <JobProgress view={job} stages={JOB_STAGES} running={running} label="Installing Mumble" closeNote="Keep this open: once Mumble is running, Gluon sets its admin password." />
            {failure && (
              <Notice tone="fault" title="The voice server wasn't set up">
                {failure}
              </Notice>
            )}
          </>
        )}

        {step === "ready" && done && <Ready done={done} />}
      </div>
    </Dialog>
  );
}

function Ready({ done }: { done: Done }) {
  const address = `${done.host}${done.port === 64738 ? "" : `:${done.port}`}`;
  return (
    <div className={s.steps}>
      <p className={s.hint}>Add the server in a Mumble app with this address, or open the link on a device that has Mumble.</p>
      <dl className={s.creds}>
        <div className={s.cred}>
          <dt>Address</dt>
          <dd>
            <span className={s.credValue}>{address}</span>
            <CopyButton value={address} label="Copy address" />
          </dd>
        </div>
        <div className={s.cred}>
          <dt>Link</dt>
          <dd>
            <span className={s.credValue}>{done.link}</span>
            <CopyButton value={done.link} label="Copy link" />
          </dd>
        </div>
        <div className={s.cred}>
          <dt>Admin (SuperUser) password</dt>
          <dd>
            <span className={s.credValue}>{done.superuser}</span>
            <CopyButton value={done.superuser} label="Copy password" />
          </dd>
        </div>
      </dl>
      <div>
        <a className={buttonClass({})} href={done.link}>
          Open in Mumble
        </a>
      </div>
      <Notice tone="attention" title="Save the admin password now">
        Gluon doesn&rsquo;t keep it and won&rsquo;t show it again. Sign in as SuperUser with it to set permissions from a Mumble app. You can set a new one in the Voice server tab.
      </Notice>
    </div>
  );
}
