"use client";
import * as React from "react";
import type { JobEvent } from "@/lib/builder-types";
import type { HistoryKeep, SignUp } from "@/lib/chat-types";
import { api, ApiError, streamPost, useApi } from "@/lib/client/api";
import { Button, LinkButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Segmented, Switch } from "@/components/ui/Field";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Select } from "@/components/ui/Select";
import { Notice } from "@/components/ui/Surface";
import { JobProgress } from "@/components/builder/JobProgress";
import { emptyJob, reduceJob, type JobView } from "@/components/builder/state";
import { Credentials } from "./Credentials";
import s from "./chat.module.css";

type Step = "domain" | "you" | "features" | "install" | "ready";
const STEPS: { key: Step; label: string }[] = [
  { key: "domain", label: "Domain" },
  { key: "you", label: "Your account" },
  { key: "features", label: "Features" },
  { key: "install", label: "Install" },
  { key: "ready", label: "Ready" },
];
const JOB_STAGES = [
  { key: "check", label: "Check" },
  { key: "write", label: "Write files" },
  { key: "start", label: "Start" },
  { key: "run", label: "Running" },
];

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface Plan {
  existing: { id: string; name: string }[];
  conflicts: string[];
  baseDomain: string | null;
  network: boolean;
  taken: string[];
}
interface Done {
  appId: string;
  jid: string;
  password: string;
  routeAdded: boolean;
  notes: string[];
}

/**
 * Install Prosody the way Gluon manages it: pick the chat domain and your own account, choose the
 * features chat apps expect, then Gluon installs it, publishes the domain on Network (so Caddy gets
 * a certificate Gluon copies in) and hands over the first admin's sign-in.
 */
export function ChatInstallFlow({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: plan } = useApi<Plan>(open ? "/api/chat/install" : null);
  const [step, setStep] = React.useState<Step>("domain");
  const [domain, setDomain] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [signUp, setSignUp] = React.useState<SignUp>("invite");
  const [history, setHistory] = React.useState<Exclude<HistoryKeep, "custom">>("3m");
  const [groups, setGroups] = React.useState(true);
  const [files, setFiles] = React.useState(true);
  const [push, setPush] = React.useState(true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<JobView>(emptyJob);
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState<Done | null>(null);
  // Once the app is running, a failed setup step is retried on its own: installing again would
  // trip over the ports the first copy already holds.
  const [installed, setInstalled] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setStep("domain");
    setUsername("");
    setErrors({});
    setFailure(null);
    setJob(emptyJob);
    setDone(null);
    setInstalled(null);
  }, [open]);
  React.useEffect(() => {
    if (open && plan?.baseDomain && !domain) setDomain(`chat.${plan.baseDomain.split(".").slice(-2).join(".")}`);
  }, [open, plan?.baseDomain]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => abort.current?.abort(), []);

  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const body = { domain: d, username: username.trim().toLowerCase(), signUp, history, groups, files, push };

  function check(at: Step): boolean {
    const e: Record<string, string> = {};
    if (at === "domain") {
      if (!DOMAIN_RE.test(d)) e.domain = "Enter a domain like chat.example.com.";
      else if (plan?.taken.includes(d)) e.domain = `${d} already has an address on Network. Pick another name, or remove that address first.`;
    }
    if (at === "you" && !USERNAME_RE.test(body.username)) e.username = body.username ? "Use lowercase letters, numbers, dots, dashes or underscores." : "Choose your username.";
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
      let draftId = installed;
      if (!draftId) {
        draftId = (await api.post<{ draftId: string }>("/api/chat/install", body)).draftId;
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
        setInstalled(draftId);
      }
      setJob((v) => ({ ...v, result: { ok: true, message: "Prosody is running. Setting up your account and the chat domain…" } }));
      const r = await api.post<Done>("/api/chat/install/finish", { ...body, draftId });
      setDone(r);
      setStep("ready");
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") {
        setStep("features");
        return;
      }
      setFailure(e instanceof Error ? e.message : "The chat server wasn't set up.");
    } finally {
      setRunning(false);
    }
  }

  const blocked = plan && plan.conflicts.length > 0;
  const idx = STEPS.findIndex((x) => x.key === step);
  const next = () => {
    if (step === "domain" && check("domain")) setStep("you");
    else if (step === "you" && check("you")) setStep("features");
    else if (step === "features") void install();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      size="wide"
      title={step === "ready" ? "Your chat server is ready" : "Set up a chat server"}
      description={step === "ready" ? undefined : "Prosody, an XMPP server: private chat that works with Monal, Conversations, Gajim and other apps."}
      footer={
        step === "ready" && done ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <LinkButton variant="primary" href={`/apps/${encodeURIComponent(done.appId)}?tab=chat`} onClick={() => onOpenChange(false)}>
              Manage the chat server
            </LinkButton>
          </>
        ) : step === "install" ? (
          failure ? (
            installed ? (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => void install()}>
                  Try the setup again
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setStep("features")}>
                Back
              </Button>
            )
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
            <Button variant="primary" disabled={!plan || !!blocked} onClick={next}>
              {step === "features" ? "Install" : "Continue"}
            </Button>
          </>
        )
      }
    >
      <div className={s.form}>
        <FlowSteps label="Setting up a chat server" steps={STEPS} current={step} working={running} failed={!!failure} complete={step === "ready"} />

        {blocked && step !== "ready" && (
          <Notice tone="attention" title="The chat ports are taken">
            {plan!.conflicts[0]} {plan!.existing.length ? `You already run ${plan!.existing.map((x) => x.name).join(" and ")}; manage it from its Chat server tab instead.` : "Stop whatever uses them first."}
          </Notice>
        )}

        {step === "domain" && (
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              next();
            }}
          >
            <Field label="Chat domain" error={errors.domain} description={`Everyone's address ends in it, like you@${d || "chat.example.com"}. It can't change later without moving every account.`}>
              <Input mono value={domain} onChange={(e) => setDomain(e.target.value.replace(/\s/g, ""))} placeholder="chat.example.com" spellCheck={false} autoCapitalize="off" autoFocus />
            </Field>
            <p className={s.hint}>
              {plan?.network
                ? `Gluon publishes it on Network, keeps its certificate current, and checks chat apps can reach it. It needs a DNS record pointing at your home (the *.${plan.baseDomain} wildcard covers names under it), and your router has to forward ports 5222 and 5269 to this server.`
                : "Point the domain's DNS at your home and forward ports 5222 and 5269 to this server."}
            </p>
          </form>
        )}

        {step === "you" && (
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              next();
            }}
          >
            <Field label="Your username" error={errors.username} description="Gluon makes this account an admin and shows you its password once.">
              <AffixInput mono after={`@${d}`} value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, "").toLowerCase())} placeholder="you" spellCheck={false} autoCapitalize="off" autoFocus />
            </Field>
          </form>
        )}

        {step === "features" && (
          <div className={s.settings}>
            <div className={s.setting}>
              <div className={s.settingText}>
                <span className={s.settingTitle}>Who can make an account</span>
                <p className={s.settingDesc}>{signUp === "invite" ? "You and your members invite people with links." : signUp === "closed" ? "You add accounts or send invite links from Gluon." : "Anyone who finds the server. Spammers look for these."}</p>
              </div>
              <div className={s.signUp}>
                <Segmented
                  aria-label="Who can make an account"
                  value={signUp}
                  onChange={setSignUp}
                  options={[
                    { value: "closed", label: "Only you" },
                    { value: "invite", label: "You and members invite" },
                    { value: "open", label: "Anyone" },
                  ]}
                />
              </div>
            </div>
            <Toggle title="Group chats" desc={`Rooms at rooms.${d}.`} checked={groups} onChange={setGroups} />
            <Toggle title="Photos and files" desc={`Up to 100 MB, kept a month, sent through https://${d}.`} checked={files} onChange={setFiles} />
            <Toggle title="Notifications when the app is closed" desc="For iPhone apps like Monal." checked={push} onChange={setPush} />
            <div className={s.setting}>
              <div className={s.settingText}>
                <span className={s.settingTitle}>Message history</span>
                <p className={s.settingDesc}>Kept on the server so every device shows the same conversation.</p>
              </div>
              <div className={s.settingControl}>
                <Select
                  aria-label="Message history"
                  value={history}
                  onChange={setHistory}
                  options={[
                    { value: "off", label: "Don't keep" },
                    { value: "1w", label: "A week" },
                    { value: "1m", label: "A month" },
                    { value: "3m", label: "Three months" },
                    { value: "1y", label: "A year" },
                    { value: "never", label: "Forever" },
                  ]}
                />
              </div>
            </div>
          </div>
        )}

        {step === "install" && (
          <>
            <JobProgress view={job} stages={JOB_STAGES} running={running} label="Installing Prosody" closeNote="Keep this open: once Prosody is running, Gluon sets up your account and the chat domain." />
            {failure && (
              <Notice tone="fault" title={installed ? "Prosody is installed, but setting it up stopped" : "The chat server wasn't set up"}>
                {failure}
                {installed ? " Try the setup again to finish; it picks up where it stopped." : ""}
              </Notice>
            )}
          </>
        )}

        {step === "ready" && done && (
          <>
            <Credentials appId={done.appId} jid={done.jid} password={done.password} />
            {done.routeAdded && <p className={s.hint}>{d} is on Network now. Caddy gets its certificate within a minute or two, and Gluon copies it into Prosody.</p>}
            <p className={s.hint}>For voice and video calls between homes and on mobile data, set up calls on the Chat server tab.</p>
            {done.notes.map((n) => (
              <Notice key={n} tone="attention">
                {n}
              </Notice>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Toggle({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={s.setting} data-toggle="">
      <div className={s.settingText}>
        <span className={s.settingTitle}>{title}</span>
        <p className={s.settingDesc}>{desc}</p>
      </div>
      <div className={s.settingControl}>
        <Switch checked={checked} onChange={onChange} aria-label={title} />
      </div>
    </div>
  );
}
