"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, LinkButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field, Input } from "@/components/ui/Field";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import { api, ApiError } from "@/lib/client/api";
import s from "../auth.module.css";

/** Where this copy of Gluon writes its log, which is where the setup code is. */
export type CodeWhere = { kind: "umbrel"; container: string | null } | { kind: "docker"; container: string } | { kind: "development" } | { kind: "unknown" };

type Form = { code: string; displayName: string; username: string; password: string; confirm: string };

const CODE_IN_TEXT = /[0-9A-F]{4}-?[0-9A-F]{4}-?[0-9A-F]{4}/i;

function Command({ cmd }: { cmd: string }) {
  return (
    <span className={s.command}>
      <code className={s.code}>{cmd}</code>
      <CopyButton value={cmd} label="Copy command" />
    </span>
  );
}

/** Exactly where to look, for the way this server runs Gluon. */
function WhereToLook({ where }: { where: CodeWhere }) {
  switch (where.kind) {
    case "umbrel":
      return (
        <>
          <p>In Umbrel, right-click the Gluon icon and choose Troubleshoot. The code is in the log.</p>
          {where.container && (
            <p>
              Or over SSH: <Command cmd={`docker logs ${where.container}`} />
            </p>
          )}
        </>
      );
    case "docker":
      return (
        <p>
          On the server, run <Command cmd={`docker logs ${where.container}`} />
        </p>
      );
    case "development":
      return <p>It&apos;s in the terminal running the dev server.</p>;
    default:
      return (
        <>
          <p>
            On the server, run <Command cmd="docker logs gluon" /> with your container&apos;s name.
          </p>
          <p>On Umbrel, right-click the Gluon icon and choose Troubleshoot.</p>
        </>
      );
  }
}

/**
 * Claim a fresh server: the one-time code from the log (proves you can reach the machine), then the
 * admin account. After this, the first run at /welcome takes over.
 */
export function SetupForm({ where, serverName }: { where: CodeWhere; serverName: string }) {
  const router = useRouter();
  const [f, setF] = React.useState<Form>({ code: "", displayName: "", username: "", password: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string; code?: string } | null>(null);
  const [claimed, setClaimed] = React.useState(false);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const codeRef = React.useRef<HTMLInputElement>(null);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value;
    // Pasting the whole log line ("Setup code: 3F9A-…") keeps just the code.
    if (k === "code" && v.length > 14) v = CODE_IN_TEXT.exec(v)?.[0].toUpperCase() ?? v;
    setF((p) => ({ ...p, [k]: v }));
    if (error?.field === k) setError(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (!f.code.trim()) return setError({ message: "Enter the setup code from the server's log.", field: "code" });
    if (f.username.trim().length < 2) return setError({ message: "Choose a username of at least 2 characters.", field: "username" });
    if (!f.password) return setError({ message: "Choose a password.", field: "password" });
    if (f.password !== f.confirm) return setError({ message: "The passwords don't match.", field: "confirm" });
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/setup", { code: f.code, username: f.username, displayName: f.displayName, password: f.password });
      router.replace("/welcome");
      router.refresh();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "already_setup") return setClaimed(true);
      const after = retryAfterOf(err);
      if (after) setBlockedUntil(Date.now() + after * 1000);
      setError(err instanceof ApiError ? { message: err.message, field: err.field, code: err.code } : { message: "Setup didn't finish. Check your connection and try again." });
      if (err instanceof ApiError && err.field === "code") codeRef.current?.focus();
    }
  }

  if (claimed) {
    return (
      <div className={`${s.form} appear`}>
        <h2>Gluon is already set up</h2>
        <p className={s.lede}>Someone just finished setting up {serverName}, maybe in another window. Sign in with that account.</p>
        <LinkButton href="/login" variant="primary" size="lg" block>
          Sign in
        </LinkButton>
      </div>
    );
  }

  const err = (field: string) => (error?.field === field ? error.message : null);
  const general = error && !error.field ? (error.code === "rate_limited" && wait > 0 ? `Too many tries. You can try again in ${clock(wait)}.` : error.message) : null;

  return (
    <form className={s.form} onSubmit={submit} noValidate data-wide="">
      <h2>Let&apos;s set up {serverName}</h2>
      <p className={s.lede}>First the code from its log, so we know it&apos;s yours. Then your account.</p>

      <div className={s.codeGroup}>
        <Field label="Setup code" error={err("code")}>
          <Input
            ref={codeRef}
            value={f.code}
            onChange={set("code")}
            mono
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            autoFocus
            style={{ textTransform: "uppercase" }}
          />
        </Field>
        <div className={s.where}>
          <WhereToLook where={where} />
          <p className={s.whereNote}>
            Look for the line starting <b>Setup code</b>. It survives restarts.
          </p>
        </div>
      </div>

      <Field label="Your name" optional>
        <Input value={f.displayName} onChange={set("displayName")} autoComplete="name" placeholder="e.g. Sam" maxLength={60} />
      </Field>
      <Field label="Username" error={err("username")} description="Letters, numbers, dots and dashes.">
        <Input value={f.username} onChange={set("username")} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} />
      </Field>
      <div className={s.passwordPair}>
        <Field label="Password" error={err("password")}>
          <Input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" maxLength={256} />
        </Field>
        <PasswordStrength value={f.password} context={[f.username, f.displayName, "gluon", serverName]} />
      </div>
      <Field label="Password again" error={err("confirm")}>
        <Input type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" maxLength={256} />
      </Field>
      {general && (
        <p className={s.error} role="alert">
          {general}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={wait > 0}>
        Create admin account
      </Button>
    </form>
  );
}
