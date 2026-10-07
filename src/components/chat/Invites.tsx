"use client";
import * as React from "react";
import { MoreHoriz, Copy, QrCode, Xmark, ShareIos } from "iconoir-react";
import type { ChatHostSnapshot, ChatInvite } from "@/lib/chat-types";
import { api, ApiError } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { Button, IconButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Segmented } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Notice, Panel } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AppSuggestions, ChatQr } from "./Credentials";
import s from "./chat.module.css";

const base = (appId: string) => `/api/chat/${encodeURIComponent(appId)}`;
const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";
/** The link to send: Gluon's page when it has a public address (works without an app yet), else the xmpp: link. */
const linkOf = (i: ChatInvite) => i.page ?? i.uri;

function who(i: ChatInvite, host: string) {
  if (i.reusable) return "Anyone with the link";
  return i.username ? `${i.username}@${host}` : "One new person";
}

export function Invites({ appId, host, onChanged, onInvite }: { appId: string; host: ChatHostSnapshot; onChanged: () => void; onInvite: () => void }) {
  const [confirm, confirmNode] = useConfirm();
  const [qrFor, setQrFor] = React.useState<ChatInvite | null>(null);
  const live = host.invites.filter((i) => !i.reset);
  if (!host.invitesReady && live.length === 0) return null;

  const cancel = (i: ChatInvite) =>
    confirm({
      title: "Cancel this invite?",
      consequences: ["The link stops working straight away.", "Accounts already made with it stay."],
      confirmLabel: "Cancel invite",
      cancelLabel: "Keep it",
      onConfirm: async () => {
        try {
          await api.del(`${base(appId)}/invites`, { host: host.host, token: i.token });
          toast.success("Invite cancelled");
          onChanged();
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  return (
    <Panel title="Invite links" meta={live.length ? <span className="num">{live.length}</span> : undefined} flush>
      {live.length === 0 ? (
        <div className={s.empty}>
          <p>An invite link sets up an account right in someone&rsquo;s chat app. They pick their own name and password, so you never handle it.</p>
          <Button onClick={onInvite}>Make an invite link</Button>
        </div>
      ) : (
        <ul className={s.invites}>
          {live.map((i) => (
            <li key={i.token} className={s.invite}>
              <span className={s.inviteText}>
                <span className={s.inviteName}>{who(i, host.host)}</span>
                <span className={s.inviteSub}>
                  {i.role === "admin" ? "Admin · " : ""}
                  {i.reusable ? "Works for several people" : "Works once"}, until <Time ts={i.expires} kind="dateTime" />
                </span>
              </span>
              <span className={s.inviteActions}>
                <CopyButton value={linkOf(i)} size="sm" label="Copy the link" />
                <Menu
                  trigger={
                    <IconButton label="Invite actions" size="sm">
                      <MoreHoriz />
                    </IconButton>
                  }
                  items={[
                    { label: "Show the QR code", icon: <QrCode />, onSelect: () => setQrFor(i) },
                    { label: "Copy the link", icon: <Copy />, onSelect: () => void copyText(linkOf(i)).then((ok) => (ok ? toast.success("Copied") : toast.error("Couldn't copy"))) },
                    "separator",
                    { label: "Cancel invite…", icon: <Xmark />, danger: true, onSelect: () => cancel(i) },
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {confirmNode}
      <Dialog open={!!qrFor} onOpenChange={(o) => !o && setQrFor(null)} title="Scan to join" size="wide" footer={<Button variant="primary" onClick={() => setQrFor(null)}>Done</Button>}>
        {qrFor && <InviteShare appId={appId} invite={qrFor} host={host.host} />}
      </Dialog>
    </Panel>
  );
}

function InviteShare({ appId, invite, host }: { appId: string; invite: ChatInvite; host: string }) {
  const link = linkOf(invite);
  const [canShare, setCanShare] = React.useState(false);
  React.useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);
  return (
    <div className={s.card}>
      <div className={s.qrCol}>
        <ChatQr appId={appId} text={link} label="QR code of the invite link" />
        <span className={s.qrHint}>Scan with the phone&rsquo;s camera or its chat app</span>
      </div>
      <div className={s.form}>
        <p className={s.hint}>
          {invite.page
            ? "The link opens a page that explains which app to get, then sets up their account in it."
            : "Opening the link in a chat app sets up their account. Gluon has no public address set (Settings), so the link only works on a device that already has a chat app."}
        </p>
        <div className={s.link}>
          <Input mono readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={link} size="md">
            Copy link
          </CopyButton>
        </div>
        {canShare && (
          <div>
            <Button icon={<ShareIos />} onClick={() => void navigator.share({ title: `Join ${host}`, text: `Here's your invite to chat on ${host}.`, url: link }).catch(() => undefined)}>
              Share…
            </Button>
          </div>
        )}
        <AppSuggestions />
        <p className={s.cardNote}>
          {invite.reusable ? "Works for several people" : "Works once"}, until <Time ts={invite.expires} kind="dateTime" />.
        </p>
      </div>
    </div>
  );
}

export function InviteDialog({ open, onOpenChange, appId, host, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; host: ChatHostSnapshot; onCreated: () => void }) {
  const [kind, setKind] = React.useState<"one" | "many">("one");
  const [username, setUsername] = React.useState("");
  const [role, setRole] = React.useState<"member" | "admin">("member");
  const [days, setDays] = React.useState<"1" | "7" | "30">("7");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<ChatInvite | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setKind("one");
    setUsername("");
    setRole("member");
    setDays("7");
    setError(null);
    setFieldError(null);
    setMade(null);
  }, [open]);

  async function create() {
    const name = username.trim().toLowerCase();
    if (kind === "one" && name && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      setFieldError("Use lowercase letters, numbers, dots, dashes or underscores.");
      return;
    }
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const inv = await api.post<ChatInvite>(`${base(appId)}/invites`, { host: host.host, username: kind === "one" ? name || null : null, role: kind === "many" ? "member" : role, days: Number(days), reusable: kind === "many" });
      setMade(inv);
      onCreated();
    } catch (e) {
      if (quiet(e)) return;
      if (e instanceof ApiError && e.field === "username") setFieldError(e.message);
      else setError(e instanceof Error ? e.message : "The invite wasn't made.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size={made ? "wide" : "default"}
      title={made ? "Send this invite" : "Invite someone to chat"}
      description={made ? undefined : "They get a link that sets up an account in their chat app. They choose their own password."}
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
      {made ? (
        <InviteShare appId={appId} invite={made} host={host.host} />
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {error && (
            <Notice tone="fault" title="The invite wasn't made">
              {error}
            </Notice>
          )}
          <Field label="Who it's for">
            <Segmented
              aria-label="Who it's for"
              value={kind}
              onChange={setKind}
              options={[
                { value: "one", label: "One person" },
                { value: "many", label: "Several people" },
              ]}
            />
          </Field>
          {kind === "one" ? (
            <Field label="Their username" optional error={fieldError} description="Leave it empty to let them pick.">
              <AffixInput after={`@${host.host}`} value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, "").toLowerCase())} autoCapitalize="off" autoComplete="off" spellCheck={false} maxLength={64} placeholder="sam" mono />
            </Field>
          ) : (
            <p className={s.hint}>Anyone with the link can make a member account until it expires, like a family group chat link. Cancel it once everyone has joined.</p>
          )}
          <div className={s.row2}>
            <Field label="Link works for">
              <Segmented
                aria-label="Link works for"
                value={days}
                onChange={setDays}
                options={[
                  { value: "1", label: "A day" },
                  { value: "7", label: "A week" },
                  { value: "30", label: "A month" },
                ]}
              />
            </Field>
            {kind === "one" && (
              <Field label="Role">
                <Segmented
                  aria-label="Role"
                  value={role}
                  onChange={setRole}
                  options={[
                    { value: "member", label: "Member" },
                    { value: "admin", label: "Admin" },
                  ]}
                />
              </Field>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
