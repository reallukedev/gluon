"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import { api, ApiError } from "@/lib/client/api";
import s from "../auth.module.css";

type Form = { code: string; displayName: string; username: string; password: string; confirm: string };

export function SetupForm() {
  const router = useRouter();
  const [f, setF] = React.useState<Form>({ code: "", displayName: "", username: "", password: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string; code?: string } | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (!f.code.trim()) return setError({ message: "Enter the setup code from the server log.", field: "code" });
    if (f.username.trim().length < 2) return setError({ message: "Choose a username of at least 2 characters.", field: "username" });
    if (!f.password) return setError({ message: "Choose a password.", field: "password" });
    if (f.password !== f.confirm) return setError({ message: "The passwords don't match.", field: "confirm" });
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/setup", { code: f.code, username: f.username, displayName: f.displayName, password: f.password });
      router.replace("/?welcome=1");
      router.refresh();
    } catch (err) {
      const after = retryAfterOf(err);
      if (after) setBlockedUntil(Date.now() + after * 1000);
      setError(err instanceof ApiError ? { message: err.message, field: err.field, code: err.code } : { message: "Setup didn't finish. Check your connection and try again." });
      setBusy(false);
    }
  }

  const err = (field: string) => (error?.field === field ? error.message : null);
  const general = error && !error.field ? (error.code === "rate_limited" && wait > 0 ? `Too many tries. You can try again in ${clock(wait)}.` : error.message) : null;

  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <h2>Set up Gluon</h2>
      <p className={s.lede}>Create the admin account for this server. You can invite the rest of the household afterwards.</p>
      <Field
        label="Setup code"
        error={err("code")}
        description={
          <>
            Printed in the server log. On the server, run <span className={s.code}>docker logs gluon</span> to see it.
          </>
        }
      >
        <Input value={f.code} onChange={set("code")} mono autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" autoFocus style={{ textTransform: "uppercase" }} />
      </Field>
      <Field label="Your name" optional>
        <Input value={f.displayName} onChange={set("displayName")} autoComplete="name" placeholder="e.g. Sam" maxLength={60} />
      </Field>
      <Field label="Username" error={err("username")} description="What you'll type to sign in. Letters, numbers, dots and dashes.">
        <Input value={f.username} onChange={set("username")} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} />
      </Field>
      <div className={s.passwordPair}>
        <Field label="Password" error={err("password")}>
          <Input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" maxLength={256} />
        </Field>
        <PasswordStrength value={f.password} context={[f.username, f.displayName, "gluon"]} />
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
