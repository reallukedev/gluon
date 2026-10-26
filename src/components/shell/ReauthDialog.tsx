"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Otp } from "@/components/ui/Otp";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import { api, ApiError, setReauthHandler } from "@/lib/client/api";
import { useViewer } from "@/components/PrefsProvider";

/**
 * Risky actions (power, disks, deleting things, security changes) need a fresh password (and a
 * two-step code when that's on). The API client calls this, waits for the answer, then retries the
 * original request. Confirming covers the next 10 minutes.
 */
export function ReauthDialog() {
  const viewer = useViewer();
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  // The server may know two-step was just turned on before this page's copy of the viewer does.
  const [askedCode, setAskedCode] = React.useState(false);
  const needCode = viewer.mfa || askedCode;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string; code?: string } | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const pending = React.useRef<((ok: boolean) => void) | null>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const codeErrorId = React.useId();

  React.useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          // A second request arriving while the dialog is open waits on the same answer.
          const prev = pending.current;
          pending.current = (ok) => {
            prev?.(ok);
            resolve(ok);
          };
          if (prev) return;
          setPassword("");
          setCode("");
          setError(null);
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  function finish(ok: boolean) {
    setOpen(false);
    pending.current?.(ok);
    pending.current = null;
  }

  async function submit(codeValue = code) {
    if (busy || wait > 0 || !password || (needCode && codeValue.length < 6)) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/reauth", { password, code: needCode ? codeValue : undefined });
      setBusy(false);
      finish(true);
    } catch (err) {
      const after = retryAfterOf(err);
      if (after) setBlockedUntil(Date.now() + after * 1000);
      if (err instanceof ApiError && err.code === "code_required") setAskedCode(true);
      setError(err instanceof ApiError ? { message: err.message, field: err.field, code: err.code } : { message: "That didn't work. Check your connection and try again." });
      if (err instanceof ApiError && err.field === "password") {
        setPassword("");
        passwordRef.current?.focus();
      }
      setCode("");
      setBusy(false);
    }
  }

  const throttled = error?.code === "rate_limited" && wait > 0 ? `Too many tries. You can try again in ${clock(wait)}.` : null;
  const passwordError = throttled ?? (error && (error.field === "password" || !error.field) ? error.message : null);
  const codeError = !throttled && error?.field === "code" ? error.message : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish(false);
      }}
      title="Confirm it's you"
      description={`This change affects the whole server, so Gluon asks for your password${needCode ? " and a code" : ""} again. You won't be asked again for 10 minutes.`}
      initialFocus={passwordRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} disabled={wait > 0 || !password || (needCode && code.length < 6)}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "grid", gap: 16 }}
        noValidate
      >
        <input type="text" name="username" autoComplete="username" value={viewer.username} readOnly hidden />
        <Field label={`Password for ${viewer.username}`} error={passwordError}>
          <Input ref={passwordRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={256} />
        </Field>
        {needCode && (
          <div style={{ display: "grid", gap: 8 }} role="group" aria-labelledby={`${codeErrorId}-l`}>
            <span id={`${codeErrorId}-l`} style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
              Code from your authenticator app
            </span>
            <Otp
              value={code}
              onChange={setCode}
              invalid={!!codeError}
              disabled={busy || wait > 0}
              aria-describedby={codeError ? codeErrorId : undefined}
              onComplete={(v) => {
                if (password) void submit(v);
              }}
            />
            {codeError && (
              <span id={codeErrorId} role="alert" style={{ color: "var(--fault)", fontSize: "var(--text-sm)" }}>
                {codeError}
              </span>
            )}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
