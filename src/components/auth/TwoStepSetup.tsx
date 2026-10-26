"use client";
import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Otp } from "@/components/ui/Otp";
import { CopyButton } from "@/components/ui/CopyButton";
import { ApiError } from "@/lib/client/api";
import s from "./parts.module.css";

export interface Enrolment {
  secret: string;
  qrSvg: string;
  ticket: string;
}

interface Props {
  /** Ask the server for a fresh secret + QR code. */
  begin: () => Promise<Enrolment>;
  /** Link it: resolves with the recovery codes. */
  confirm: (e: Enrolment, code: string) => Promise<string[]>;
  onDone: (codes: string[]) => void;
  onCancel?: () => void;
  confirmLabel?: string;
}

/**
 * Link an authenticator app: scan (or type) the key, then prove it with the first code. The code
 * submits itself when the sixth digit lands; a wrong one clears the boxes and says why.
 */
export function TwoStepSetup({ begin, confirm, onDone, onCancel, confirmLabel = "Turn on" }: Props) {
  const [enrol, setEnrol] = React.useState<Enrolment | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [showKey, setShowKey] = React.useState(false);
  const errorId = React.useId();

  const start = React.useCallback(async () => {
    setEnrol(null);
    setLoadError(null);
    setExpired(false);
    setCode("");
    setError(null);
    try {
      setEnrol(await begin());
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") {
        onCancel?.();
        return;
      }
      setLoadError(e instanceof Error ? e.message : "Couldn't start. Try again.");
    }
  }, [begin, onCancel]);

  // Ask for a secret once when shown (a second request would replace the QR being scanned).
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  async function verify(value = code) {
    if (!enrol || busy || value.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await confirm(enrol, value));
    } catch (e) {
      if (e instanceof ApiError && e.code === "enrol_expired") setExpired(true);
      setError(e instanceof Error ? e.message : "That code didn't work.");
      setCode("");
      setBusy(false);
    }
  }

  const grouped = enrol?.secret.replace(/(.{4})/g, "$1 ").trim() ?? "";

  return (
    <form
      className={s.setup}
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <ol className={s.setupSteps}>
        <li>
          <span>
            Open an authenticator app on your phone (1Password, Google Authenticator, Authy, Microsoft Authenticator…) and scan this code.
          </span>
          <div className={s.qrRow}>
            {enrol ? (
              <div className={s.qr} role="img" aria-label="QR code to add Gluon to your authenticator app" dangerouslySetInnerHTML={{ __html: enrol.qrSvg }} />
            ) : (
              <div className={s.qrSkeleton} aria-hidden data-motion-gentle="" />
            )}
            <div className={s.keyBox}>
              <button type="button" className={s.linkButton} onClick={() => setShowKey((v) => !v)} aria-expanded={showKey} disabled={!enrol}>
                {showKey ? "Hide the setup key" : "Can't scan? Type a key instead"}
              </button>
              {showKey && enrol && (
                <>
                  <code className={s.key}>{grouped}</code>
                  <span className={s.stepNote}>Choose “time-based” if the app asks. Spaces don't matter.</span>
                  <CopyButton value={enrol.secret} size="sm" variant="secondary">
                    Copy key
                  </CopyButton>
                </>
              )}
            </div>
          </div>
          {loadError && (
            <p className={s.error} role="alert">
              {loadError}{" "}
              <button type="button" className={s.linkButton} onClick={() => void start()}>
                Try again
              </button>
            </p>
          )}
        </li>
        <li>
          <span>Enter the 6-digit code the app shows for Gluon.</span>
          <div className={s.otpRow}>
            <Otp value={code} onChange={setCode} onComplete={(v) => void verify(v)} invalid={!!error} disabled={busy || !enrol || expired} aria-describedby={error ? errorId : undefined} />
            {error && (
              <p className={s.error} id={errorId} role="alert">
                {error}
              </p>
            )}
            {expired && (
              <button type="button" className={s.linkButton} onClick={() => void start()}>
                Get a fresh code
              </button>
            )}
          </div>
        </li>
      </ol>
      <div className={s.actions}>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!enrol || code.length < 6 || expired}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
