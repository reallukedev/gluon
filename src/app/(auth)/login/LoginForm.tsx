"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Otp } from "@/components/ui/Otp";
import { Notice } from "@/components/ui/Surface";
import { ZoneLine } from "@/components/auth/ZoneLine";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import { api, ApiError } from "@/lib/client/api";
import s from "../auth.module.css";

type Step = "password" | "code" | "recovered";
interface Problem {
  message: string;
  code?: string;
}

interface Props {
  next: string;
  zone: "home" | "away";
  serverName: string;
  adminsNeedCode: boolean;
}

export function LoginForm({ next, zone, serverName, adminsNeedCode }: Props) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("password");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<Problem | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const [left, setLeft] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const blocked = wait > 0;
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();

  // The throttle message counts down in place and clears itself when the wait is over.
  React.useEffect(() => {
    if (blockedUntil && wait === 0) {
      setBlockedUntil(null);
      setProblem((p) => (p?.code === "rate_limited" ? null : p));
    }
  }, [wait, blockedUntil]);

  function fail(err: unknown, fallback: string) {
    const after = retryAfterOf(err);
    if (after) setBlockedUntil(Date.now() + after * 1000);
    if (err instanceof ApiError) setProblem({ message: err.message, code: err.code });
    else setProblem({ message: fallback });
  }

  function go() {
    router.replace(next);
    router.refresh();
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy || blocked) return;
    if (!username.trim() || !password) {
      setProblem({ message: !username.trim() ? "Enter your username." : "Enter your password." });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.post<{ next: "mfa" | "done" }>("/api/auth/login", { username, password });
      if (r.next === "mfa") {
        setStep("code");
        setCode("");
        setBusy(false);
      } else {
        go();
      }
    } catch (err) {
      fail(err, "Couldn't sign in. Check your connection and try again.");
      if (err instanceof ApiError && err.code === "bad_credentials") {
        setPassword("");
        passwordRef.current?.focus();
      }
      setBusy(false);
    }
  }

  async function submitCode(value = code) {
    if (busy || blocked) return;
    const v = value.trim();
    if (!recovery && v.length < 6) return;
    if (recovery && v.replace(/[^a-z0-9]/gi, "").length < 10) {
      setProblem({ message: "Recovery codes look like 1a2b3-c4d5e." });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.post<{ usedRecovery: boolean; remainingRecovery: number | null }>("/api/auth/mfa", { code: v });
      if (r.usedRecovery) {
        setLeft(r.remainingRecovery);
        setStep("recovered");
        setBusy(false);
      } else {
        go();
      }
    } catch (err) {
      fail(err, "That code didn't work.");
      if (err instanceof ApiError && err.code === "no_pending") {
        setStep("password");
        setPassword("");
        setRecovery(false);
      }
      setCode("");
      setBusy(false);
    }
  }

  function startOver() {
    setStep("password");
    setPassword("");
    setCode("");
    setRecovery(false);
    setProblem(null);
  }

  const message = problem ? (problem.code === "rate_limited" && blocked ? `Too many tries. You can try again in ${clock(wait)}.` : problem.message) : null;

  if (step === "recovered") {
    return (
      <div className={`${s.form} appear`}>
        <h2>You're signed in</h2>
        <p className={s.lede}>
          You used a recovery code.{" "}
          {left === 0 ? (
            <>That was your last one.</>
          ) : (
            <>
              You have <b className={s.figure}>{left}</b> left.
            </>
          )}{" "}
          If your phone is gone for good, move two-step sign-in to your new phone and make fresh codes in Settings.
        </p>
        <div className={s.buttons}>
          <LinkButton href="/settings/security" variant="primary" size="lg" block>
            Open Security settings
          </LinkButton>
          <Button variant="ghost" size="lg" block onClick={go}>
            Continue for now
          </Button>
        </div>
      </div>
    );
  }

  if (step === "code") {
    return (
      <form
        className={`${s.form} appear`}
        onSubmit={(e) => {
          e.preventDefault();
          void submitCode();
        }}
        noValidate
      >
        <h2>{recovery ? "Use a recovery code" : "Enter your code"}</h2>
        <p className={s.lede}>
          {recovery
            ? "Type one of the recovery codes you saved when you turned on two-step sign-in. Each works once."
            : `Open your authenticator app and enter the 6-digit code for Gluon (${serverName}).`}
        </p>
        {recovery ? (
          <Field label="Recovery code" error={message}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxxx-xxxxx"
              mono
              autoFocus
              disabled={blocked}
            />
          </Field>
        ) : (
          <div className={s.codeBlock}>
            <Otp value={code} onChange={setCode} onComplete={(v) => void submitCode(v)} invalid={!!message} autoFocus disabled={busy || blocked} aria-describedby={message ? errorId : undefined} />
            {message && (
              <p className={s.error} role="alert" id={errorId}>
                {message}
              </p>
            )}
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={blocked || (!recovery && code.length < 6)}>
          Verify
        </Button>
        <div className={s.links}>
          <button
            type="button"
            className={s.linkButton}
            onClick={() => {
              setRecovery((r) => !r);
              setCode("");
              setProblem((p) => (p?.code === "rate_limited" ? p : null));
            }}
          >
            {recovery ? "Use my authenticator app" : "Lost your phone? Use a recovery code"}
          </button>
          <button type="button" className={s.linkButton} onClick={startOver}>
            Start over
          </button>
        </div>
      </form>
    );
  }

  const awayRule = problem?.code === "mfa_required_away";
  return (
    <form className={s.form} onSubmit={submitPassword} noValidate>
      <h2>Sign in</h2>
      <ZoneLine zone={zone} serverName={serverName}>
        {zone === "home" ? (
          <>You're on the home network.</>
        ) : adminsNeedCode ? (
          <>
            You're <b>away from home</b>. Admins also need a code from their authenticator app.
          </>
        ) : (
          <>
            You're <b>away from home</b>.
          </>
        )}
      </ZoneLine>
      <Field label="Username">
        <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required />
      </Field>
      <Field label="Password">
        <Input ref={passwordRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-describedby={message && !awayRule ? errorId : undefined} />
      </Field>
      {awayRule ? (
        <Notice tone="attention" title="Two-step sign-in needed away from home">
          This admin account doesn't have two-step sign-in yet, so it can only sign in on the home network. Sign in there once and turn it on in Settings → Security.
        </Notice>
      ) : (
        message && (
          <p className={s.error} role="alert" id={errorId}>
            {message}
          </p>
        )
      )}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={blocked}>
        {blocked ? `Try again in ${clock(wait)}` : "Sign in"}
      </Button>
      <p className={s.foot}>Forgot your password? Ask whoever runs this server to set a temporary one for you.</p>
    </form>
  );
}
