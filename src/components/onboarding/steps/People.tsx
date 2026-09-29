"use client";
import * as React from "react";
import Link from "next/link";
import { ShareIos } from "iconoir-react";
import type { CreatedInvite, InviteView } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field, Input } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { Actions, StepHead, useFlow } from "../flow";
import o from "../onboarding.module.css";

type Role = "member" | "admin";

const ROLES: { value: Role; title: string; body: string }[] = [
  { value: "member", title: "In the household", body: "Opens the apps you share, sees if something is broken and can tell you. Can't change anything risky." },
  { value: "admin", title: "An admin", body: "Can change everything on the server, including other people's accounts." },
];

/**
 * Admin (the one who set the server up): invite the people who live there. Each invite shows its
 * link and a QR code once (only a fingerprint is stored), then the next can be made. Invites still
 * waiting (made earlier, or before a sign-out) are listed from the server.
 */
export function PeopleStep() {
  const { next } = useFlow();
  const open = useApi<InviteView[]>("/api/people/invites", { revalidateOnFocus: false });
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<CreatedInvite | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [qrFailed, setQrFailed] = React.useState(false);
  const [canShare, setCanShare] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const roleGroup = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const inv = await api.post<CreatedInvite>("/api/people/invites", { role, displayName: name.trim() || null });
      setMade(inv);
      setQr(null);
      setQrFailed(false);
      void open.mutate();
      api
        .post<{ svg: string }>("/api/people/invites/qr", { url: inv.url })
        .then((r) => setQr(r.svg))
        .catch(() => setQrFailed(true));
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "reauth_cancelled")) setError(err instanceof Error ? err.message : "Couldn't make the invite.");
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setMade(null);
    setName("");
    setRole("member");
    requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function share() {
    if (!made) return;
    try {
      await navigator.share({ title: "Your invite", text: `Here's your invite${made.displayName ? `, ${made.displayName}` : ""}. It works once.`, url: made.url });
    } catch {
      /* closed the share sheet */
    }
  }

  const waiting = (open.data ?? []).filter((i) => i.id !== made?.id);
  const anyInvite = !!made || waiting.length > 0;
  const lanOnly = made?.url.startsWith("http://");

  return (
    <>
      <StepHead title="Who else lives here?">
        <p>Invite the people who use the apps on this server. Each gets a link to choose their own username and password, and sees only what you share with them.</p>
      </StepHead>

      {made ? (
        <section className={o.invite} aria-labelledby="invite-made">
          <h2 id="invite-made" className={o.sectionTitle}>
            Invite for {made.displayName ?? "someone new"}
          </h2>
          <div className={o.inviteBody}>
            <div className={o.qrCol}>
              {qr ? (
                <div className={o.qr} role="img" aria-label="QR code of the invite link" dangerouslySetInnerHTML={{ __html: qr }} />
              ) : qrFailed ? (
                <div className={o.qrMissing}>No QR code this time. The link works the same.</div>
              ) : (
                <Skeleton width={148} height={148} radius={10} />
              )}
              {qr && <span className={o.qrHint}>Scan with a phone camera</span>}
            </div>
            <div className={o.linkCol}>
              <div className={o.linkRow}>
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
              <p className={o.note}>
                Works once, until <Time ts={made.expiresAt} kind="dateTime" />.
                {lanOnly && (
                  <>
                    {" "}
                    It points at the home network, so it opens on Wi-Fi at home. A public name in <Link href="/settings/server">Settings → Server</Link> makes links that work anywhere.
                  </>
                )}
              </p>
            </div>
          </div>
          <Notice tone="attention" title="Send it now">
            This is the only time the link is shown. If it gets lost, cancel it in Settings → People and make a new one.
          </Notice>
          <div>
            <Button onClick={another}>Invite someone else</Button>
          </div>
        </section>
      ) : (
        <form id="invite-form" className={o.stack} onSubmit={(e) => void create(e)} noValidate>
          <Field label="Their name" optional description="Shown on their invite page. They can change it.">
            <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" placeholder="e.g. Sam" />
          </Field>
          <div
            ref={roleGroup}
            className={o.choices}
            role="radiogroup"
            aria-label="They'll be"
            onKeyDown={(e) => {
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
              e.preventDefault();
              const v: Role = role === "member" ? "admin" : "member";
              setRole(v);
              roleGroup.current?.querySelector<HTMLElement>(`[data-value="${v}"]`)?.focus();
            }}
          >
            {ROLES.map((r) => (
              <button key={r.value} type="button" role="radio" aria-checked={role === r.value} tabIndex={role === r.value ? 0 : -1} data-value={r.value} className={o.choice} onClick={() => setRole(r.value)}>
                <span className={o.radio} aria-hidden />
                <span className={o.choiceText}>
                  <b>{r.title}</b>
                  <span>{r.body}</span>
                </span>
              </button>
            ))}
          </div>
          {error && (
            <p className={o.error} role="alert">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" variant={anyInvite ? "secondary" : "primary"} loading={busy}>
              Create invite
            </Button>
          </div>
        </form>
      )}

      {waiting.length > 0 && (
        <section className={o.stack} aria-labelledby="invites-waiting">
          <h2 id="invites-waiting" className={o.sectionTitle}>
            Waiting to join
          </h2>
          <ul className={o.list}>
            {waiting.map((i) => (
              <li key={i.id} className={o.listRow}>
                <span className={o.listText}>
                  <b>{i.displayName ?? "Someone new"}</b>
                  <span>
                    {i.role === "admin" ? "Admin" : "Household"} · link works until <Time ts={i.expiresAt} kind="date" />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {open.error && !open.data && <p className={o.note}>Couldn&apos;t list the invites already waiting. People shows them.</p>}

      <Actions
        skip={anyInvite ? undefined : { label: "Skip for now", onClick: next, disabled: busy }}
        primary={
          anyInvite ? (
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          ) : undefined
        }
      />
    </>
  );
}
