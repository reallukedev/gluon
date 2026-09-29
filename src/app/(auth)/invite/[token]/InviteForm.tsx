"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import { TwoStepSetup, type Enrolment } from "@/components/auth/TwoStepSetup";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { api, ApiError } from "@/lib/client/api";
import s from "../../auth.module.css";

interface Props {
  token: string;
  displayName: string;
  role: "admin" | "member";
  serverName: string;
  /** An admin joining from outside home links an authenticator app before the first session. */
  mustEnrol: boolean;
  /** The account already exists; only the two-step part is left. */
  resume?: boolean;
  username?: string;
}

type Step = "account" | "enrol" | "codes";

const ENROL_STEPS = [
  { key: "account", label: "Create your account" },
  { key: "enrol", label: "Link your phone" },
  { key: "codes", label: "Save recovery codes" },
];

export function InviteForm({ token, displayName, role, serverName, mustEnrol, resume, username: knownUsername = "" }: Props) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>(resume ? "enrol" : "account");
  const [f, setF] = React.useState({ displayName, username: knownUsername, password: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const finish = React.useCallback(() => {
    router.replace("/welcome");
    router.refresh();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (f.username.trim().length < 2) return setError({ message: "Choose a username of at least 2 characters.", field: "username" });
    if (!f.password) return setError({ message: "Choose a password.", field: "password" });
    if (f.password !== f.confirm) return setError({ message: "The passwords don't match.", field: "confirm" });
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ next: "done" | "enrol" }>(`/api/auth/invite/${encodeURIComponent(token)}`, { displayName: f.displayName, username: f.username, password: f.password });
      if (r.next === "enrol") {
        setStep("enrol");
        setBusy(false);
      } else finish();
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: "Couldn't create your account. Check your connection and try again." });
      setBusy(false);
    }
  }

  const begin = React.useCallback(() => api.post<Enrolment>("/api/auth/enrol", { action: "begin" }), []);
  const confirm = React.useCallback(
    (e: Enrolment, code: string) => api.post<{ recoveryCodes: string[] }>("/api/auth/enrol", { action: "confirm", secret: e.secret, ticket: e.ticket, code }).then((r) => r.recoveryCodes),
    [],
  );

  if (step === "codes" && codes) {
    return (
      <div className={`${s.form} appear`} data-wide="">
        <FlowSteps steps={ENROL_STEPS} current="codes" label="Joining as an admin" />
        <h2>Save your recovery codes</h2>
        <p className={s.lede}>Two-step sign-in is on. If you ever lose your phone, one of these gets you in instead of a code.</p>
        <RecoveryCodes codes={codes} username={f.username} serverName={serverName} />
        <Button variant="primary" size="lg" block onClick={finish}>
          I've saved them, continue
        </Button>
      </div>
    );
  }

  if (step === "enrol") {
    return (
      <div className={`${s.form} appear`} data-wide="">
        <FlowSteps steps={ENROL_STEPS} current="enrol" label="Joining as an admin" />
        <h2>Link your phone</h2>
        <p className={s.lede}>
          Your account is ready. Because you're joining as an admin from outside home, Gluon asks for a code from your phone each time you sign in from away. Set that up now to finish.
        </p>
        <TwoStepSetup
          begin={begin}
          confirm={confirm}
          confirmLabel="Finish"
          onDone={(c) => {
            setCodes(c);
            setStep("codes");
          }}
        />
      </div>
    );
  }

  const err = (field: string) => (error?.field === field ? error.message : null);
  return (
    <form className={s.form} onSubmit={submit} noValidate data-wide={mustEnrol ? "" : undefined}>
      {mustEnrol && <FlowSteps steps={ENROL_STEPS} current="account" label="Joining as an admin" />}
      <h2>{displayName ? `Welcome, ${displayName}` : `Join ${serverName}`}</h2>
      <p className={s.lede}>
        {role === "admin"
          ? "You've been invited to help run this server. Choose a username and password."
          : "You've been invited to use the apps on this server. Choose a username and password to get started."}
        {mustEnrol && " You'll also link an authenticator app, since you're joining as an admin from outside home."}
      </p>
      <Field label="Your name" error={err("displayName")}>
        <Input value={f.displayName} onChange={set("displayName")} autoComplete="name" autoFocus={!displayName} maxLength={60} />
      </Field>
      <Field label="Username" error={err("username")} description="What you'll type to sign in.">
        <Input value={f.username} onChange={set("username")} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!!displayName} maxLength={32} />
      </Field>
      <div className={s.passwordPair}>
        <Field label="Password" error={err("password")}>
          <Input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" maxLength={256} />
        </Field>
        <PasswordStrength value={f.password} context={[f.username, f.displayName, serverName]} />
      </div>
      <Field label="Password again" error={err("confirm")}>
        <Input type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" maxLength={256} />
      </Field>
      {error && !error.field && (
        <p className={s.error} role="alert">
          {error.message}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        {mustEnrol ? "Continue" : "Create my account"}
      </Button>
    </form>
  );
}
