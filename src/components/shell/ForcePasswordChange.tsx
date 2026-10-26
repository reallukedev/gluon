"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { api, ApiError } from "@/lib/client/api";
import { useViewer } from "@/components/PrefsProvider";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import { clock, retryAfterOf, useCountdown } from "@/components/auth/useCountdown";
import d from "@/components/ui/dialog.module.css";

type Form = { current: string; next: string; confirm: string };

/**
 * After an admin sets a temporary password, the person chooses their own before anything else.
 * It can't be dismissed, but it can be left: "Sign out" is always there.
 */
export function ForcePasswordChange() {
  const router = useRouter();
  const viewer = useViewer();
  const [f, setF] = React.useState<Form>({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string; code?: string } | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState<number | null>(null);
  const wait = useCountdown(blockedUntil);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (!f.current) return setError({ message: "Enter the temporary password you were given.", field: "current" });
    if (!f.next) return setError({ message: "Choose a new password.", field: "next" });
    if (f.next !== f.confirm) return setError({ message: "The new passwords don't match.", field: "confirm" });
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/me/password", { current: f.current, next: f.next, signOutOthers: true });
      router.refresh();
    } catch (err) {
      const after = retryAfterOf(err);
      if (after) setBlockedUntil(Date.now() + after * 1000);
      setError(err instanceof ApiError ? { message: err.message, field: err.field === "password" ? "next" : err.field, code: err.code } : { message: "Couldn't save it. Check your connection and try again." });
      setBusy(false);
    }
  }

  async function signOut() {
    setLeaving(true);
    await api.post("/api/auth/logout").catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const err = (k: string) => (error?.field === k ? error.message : null);
  const general = error && !error.field ? (error.code === "rate_limited" && wait > 0 ? `Too many tries. You can try again in ${clock(wait)}.` : error.message) : null;

  return (
    <Dialog.Root open modal="trap-focus" onOpenChange={() => undefined} disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Backdrop className={d.backdrop} data-motion-gentle="" />
        <Dialog.Viewport className={d.viewport}>
          <Dialog.Popup className={d.popup} data-motion-gentle="">
            <form onSubmit={save} noValidate>
              <div className={d.head}>
                <div className={d.headText}>
                  <Dialog.Title className={d.title}>Choose your own password</Dialog.Title>
                  <Dialog.Description className={d.description}>
                    Someone set a temporary password for you, {viewer.displayName}. Pick one that only you know before carrying on. Your other devices will be signed out.
                  </Dialog.Description>
                </div>
              </div>
              <div className={d.body} style={{ display: "grid", gap: 16 }}>
                <input type="text" name="username" autoComplete="username" value={viewer.username} readOnly hidden />
                <Field label="Temporary password" error={err("current")}>
                  <Input type="password" autoComplete="current-password" value={f.current} onChange={set("current")} autoFocus maxLength={256} />
                </Field>
                <div style={{ display: "grid", gap: 8 }}>
                  <Field label="New password" error={err("next")}>
                    <Input type="password" autoComplete="new-password" value={f.next} onChange={set("next")} maxLength={256} />
                  </Field>
                  <PasswordStrength value={f.next} context={[viewer.username, viewer.displayName]} />
                </div>
                <Field label="New password again" error={err("confirm")}>
                  <Input type="password" autoComplete="new-password" value={f.confirm} onChange={set("confirm")} maxLength={256} />
                </Field>
                {general && (
                  <p className={d.error} role="alert" style={{ marginTop: 0 }}>
                    {general}
                  </p>
                )}
              </div>
              <div className={d.foot}>
                <Button variant="ghost" onClick={() => void signOut()} loading={leaving} disabled={busy}>
                  Sign out
                </Button>
                <Button type="submit" variant="primary" loading={busy} disabled={wait > 0 || leaving}>
                  Save my password
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
