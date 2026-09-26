"use client";
import * as React from "react";
import { ShareIos } from "iconoir-react";
import type { CreatedInvite } from "@/lib/people-types";
import { api, ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Field, Input } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import s from "./people.module.css";

/** Make a one-time invite link, then show it (with a QR code for phones) exactly once. */
export function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [role, setRole] = React.useState<"member" | "admin">("member");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<CreatedInvite | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [canShare, setCanShare] = React.useState(false);
  React.useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  React.useEffect(() => {
    if (open) {
      setRole("member");
      setName("");
      setError(null);
      setMade(null);
      setQr(null);
    }
  }, [open]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const inv = await api.post<CreatedInvite>("/api/people/invites", { role, displayName: name.trim() || null });
      setMade(inv);
      onCreated();
      api
        .post<{ svg: string }>("/api/people/invites/qr", { url: inv.url })
        .then((r) => setQr(r.svg))
        .catch(() => setQr(null));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setError(e instanceof Error ? e.message : "Couldn't make the invite.");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!made) return;
    try {
      await navigator.share({ title: "Your invite", text: `Here's your invite${made.displayName ? `, ${made.displayName}` : ""}. It works once.`, url: made.url });
    } catch {
      /* closed the share sheet */
    }
  }

  return (
    <Dialog
      size={made ? "wide" : "default"}
      open={open}
      onOpenChange={onOpenChange}
      title={made ? `Invite for ${made.displayName ?? "someone new"}` : "Invite someone"}
      description={made ? undefined : "They get a link to choose their own username and password."}
      footer={
        made ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>
              Make invite link
            </Button>
          </>
        )
      }
    >
      <FlowSteps
        className={s.inviteSteps}
        label="Inviting someone"
        current={made ? "send" : "who"}
        steps={[
          { key: "who", label: "Who it's for" },
          { key: "send", label: "Send the link" },
          { key: "join", label: "They pick a password" },
        ]}
      />
      {made ? (
        <div className={s.inviteMade}>
          <div className={s.qrCol}>
            {qr ? <div className={s.qr} role="img" aria-label="QR code of the invite link" dangerouslySetInnerHTML={{ __html: qr }} /> : <Skeleton width={168} height={168} radius={10} />}
            <span className={s.qrHint}>Scan with a phone camera</span>
          </div>
          <div className={s.linkCol}>
            <p className={s.hint}>
              Send this link to {made.displayName ?? "them"} in a message, or let them scan the code. They choose their own username and password.
            </p>
            <div className={s.link}>
              <Input mono readOnly value={made.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={made.url} size="md">
                Copy link
              </CopyButton>
            </div>
            {canShare && (
              <div>
                <Button icon={<ShareIos />} onClick={() => void share()}>
                  Share…
                </Button>
              </div>
            )}
            <p className={s.expiry}>
              Works once, until <Time ts={made.expiresAt} kind="dateTime" /> (7 days).
            </p>
            <Notice tone="attention" title="You won't see this link again">
              Gluon only keeps a fingerprint of it. If it gets lost, cancel it and make a new one.
            </Notice>
          </div>
        </div>
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="Their name" optional description="Shown on the invite page. They can change it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="e.g. Sam" />
          </Field>
          <div
            className={s.roleField}
            role="radiogroup"
            aria-label="They'll be"
            onKeyDown={(e) => {
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
              e.preventDefault();
              const next = role === "member" ? "admin" : "member";
              setRole(next);
              (e.currentTarget.querySelector(`[data-role="${next}"]`) as HTMLElement | null)?.focus();
            }}
          >
            <span className={s.roleLabel}>They'll be</span>
            {(
              [
                ["member", "In the household", "Opens their apps, sees if something is broken and reports problems. Can't change anything risky."],
                ["admin", "An admin", "Can change everything on the server, including other people's accounts. Needs two-step verification to sign in from outside home."],
              ] as const
            ).map(([v, label, desc]) => (
              <button key={v} type="button" role="radio" data-role={v} aria-checked={role === v} tabIndex={role === v ? 0 : -1} className={s.roleChoice} onClick={() => setRole(v)}>
                <span className={s.radio} aria-hidden />
                <span>
                  <b>{label}</b>
                  <small>{desc}</small>
                </span>
              </button>
            ))}
          </div>
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
