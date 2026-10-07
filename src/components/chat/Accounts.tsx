"use client";
import * as React from "react";
import { MoreHoriz, Key, LogOut, Prohibition, Play, Trash, UserCrown, User, Copy } from "iconoir-react";
import type { ChatAccount, ChatHostSnapshot } from "@/lib/chat-types";
import { api, ApiError } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Segmented } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Notice, Panel } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { Credentials, Jid } from "./Credentials";
import s from "./chat.module.css";

const ROLE_WORD: Record<ChatAccount["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", other: "Custom" };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const base = (appId: string) => `/api/chat/${encodeURIComponent(appId)}`;
const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";

function deviceWords(a: ChatAccount): string {
  const names = a.devices.map((d) => d.client ?? d.resource);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

export function Accounts({ appId, host, onChanged, onAdd }: { appId: string; host: ChatHostSnapshot; onChanged: () => void; onAdd: () => void }) {
  const [confirm, confirmNode] = useConfirm();
  const [reset, setReset] = React.useState<ChatAccount | null>(null);

  async function patch(a: ChatAccount, body: Record<string, unknown>, done: string) {
    try {
      const r = await api.patch<{ closed: number }>(`${base(appId)}/accounts/${encodeURIComponent(a.user)}`, { host: host.host, ...body });
      toast.success(done, r.closed ? { description: `${r.closed} device${r.closed === 1 ? " was" : "s were"} signed out.` } : undefined);
      onChanged();
    } catch (e) {
      if (!quiet(e)) toast.error("That didn't work", { description: e instanceof Error ? e.message : undefined });
    }
  }

  const askDelete = (a: ChatAccount) =>
    confirm({
      title: `Delete ${a.jid}?`,
      consequences: [
        "Their contacts, message history and profile on this server are deleted.",
        a.devices.length ? `${a.devices.length === 1 ? "Their device is" : `All ${a.devices.length} of their devices are`} signed out now.` : "Nobody is signed in to it right now.",
        "Someone could create the same address again later, so people who chatted with it should know.",
      ],
      confirmLabel: "Delete account",
      variant: "dangerSolid",
      typeToConfirm: a.user,
      onConfirm: async () => {
        try {
          await api.del(`${base(appId)}/accounts/${encodeURIComponent(a.user)}`, { host: host.host });
          toast.success(`Deleted ${a.jid}`);
          onChanged();
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  const askOff = (a: ChatAccount) =>
    confirm({
      title: `Turn off ${a.jid}?`,
      consequences: ["They can't sign in until you turn it back on.", a.devices.length ? "Their devices are signed out now." : "Nobody is signed in to it right now.", "Their contacts and history are kept."],
      confirmLabel: "Turn off",
      onConfirm: () => patch(a, { enabled: false }, `Turned off ${a.jid}`),
    });

  function items(a: ChatAccount): MenuEntry[] {
    const out: MenuEntry[] = [
      { label: "Copy address", icon: <Copy />, onSelect: () => void copyText(a.jid).then((ok) => (ok ? toast.success("Copied", { description: a.jid }) : toast.error("Couldn't copy"))) },
      { label: "Reset password…", icon: <Key />, onSelect: () => setReset(a), disabled: !a.enabled },
    ];
    if (a.role !== "owner") {
      out.push(
        a.role === "admin"
          ? { label: "Make a member", icon: <User />, onSelect: () => void patch(a, { role: "member" }, `${a.jid} is a member now`) }
          : { label: "Make an admin", description: "Can manage the server from a chat app", icon: <UserCrown />, onSelect: () => void patch(a, { role: "admin" }, `${a.jid} is an admin now`) },
      );
    }
    if (a.devices.length > 0) {
      out.push(
        a.devices.length === 1
          ? { label: "Sign out its device", icon: <LogOut />, onSelect: () => void patch(a, { signOut: true }, `Signed out ${a.jid}`) }
          : {
              kind: "sub",
              label: "Sign out",
              icon: <LogOut />,
              items: [
                { label: "Every device", onSelect: () => void patch(a, { signOut: true }, `Signed out ${a.jid} everywhere`) },
                "separator",
                ...a.devices.map((d) => ({ label: d.client ? `${d.client} (${d.resource})` : d.resource, onSelect: () => void patch(a, { signOut: d.resource }, `Signed out ${d.client ?? d.resource}`) })),
              ],
            },
      );
    }
    out.push("separator");
    if (a.role !== "owner") {
      out.push(a.enabled ? { label: "Turn off…", icon: <Prohibition />, onSelect: () => askOff(a) } : { label: "Turn back on", icon: <Play />, onSelect: () => void patch(a, { enabled: true }, `Turned on ${a.jid}`) });
      out.push({ label: "Delete account…", icon: <Trash />, danger: true, onSelect: () => askDelete(a) });
    } else {
      out.push({ label: "Owners are set in the config file", disabled: true });
    }
    return out;
  }

  return (
    <Panel title="People" meta={<span className="num">{host.accounts.length}</span>} flush>
      {host.accounts.length === 0 ? (
        <div className={s.empty}>
          <p>Nobody has a chat account on {host.host} yet. Add one for yourself first, then invite the people you chat with.</p>
          <Button variant="primary" onClick={onAdd}>
            Add your account
          </Button>
        </div>
      ) : (
        <div className={s.table} role="table" aria-label={`Chat accounts on ${host.host}`}>
          <div className={s.headRow} role="row">
            <span role="columnheader">Account</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Last active</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {host.accounts.map((a) => (
            <div key={a.user} role="row" className={s.row} data-off={a.enabled ? undefined : ""}>
              <span role="cell" className={s.who}>
                <span className={s.mark} aria-hidden>
                  {a.user.slice(0, 1)}
                </span>
                <span className={s.whoText}>
                  <span className={s.whoName} title={a.jid}>
                    {a.user}
                  </span>
                  <span className={`${s.whoSub} mono`}>
                    <Jid jid={a.jid} />
                    <span className={s.roleInline}> · {a.sender ? "Gluon" : ROLE_WORD[a.role]}</span>
                  </span>
                  {a.sender && <span className={s.whoSub}>Sends Gluon&rsquo;s notifications. Removing it stops chat alerts.</span>}
                </span>
              </span>
              <span role="cell" className={`${s.cell} ${s.roleCell}`} title={a.fromConfig ? "Listed in admins in Prosody's config file" : (a.roleName ?? undefined)}>
                {a.sender ? "Gluon" : ROLE_WORD[a.role]}
              </span>
              <span role="cell" className={`${s.cell} ${s.seenCell}`}>
                <span className={s.cellLabel}>Last active</span>
                {a.devices.length ? "Now" : a.lastActive ? <Time ts={a.lastActive} /> : <span className={s.muted} title="Gluon turns on activity tracking when it first saves chat settings">No record yet</span>}
              </span>
              <span role="cell" className={`${s.cell} ${s.stateCell}`}>
                {!a.enabled ? (
                  <StateLine state="stopped" label="Turned off" />
                ) : a.devices.length ? (
                  <span className={s.devices}>
                    <StateLine state="running" label={`Online on ${a.devices.length} device${a.devices.length === 1 ? "" : "s"}`} />
                    <span className={s.deviceList} title={a.devices.map((d) => `${d.client ?? d.resource}${d.ip ? ` from ${d.ip}` : ""}`).join("\n")}>
                      {deviceWords(a)}
                    </span>
                  </span>
                ) : (
                  <StateLine state="stopped" label="Offline" />
                )}
              </span>
              <span role="cell" className={s.menuCell}>
                <Menu
                  trigger={
                    <IconButton label={`Actions for ${a.jid}`} size="sm">
                      <MoreHoriz />
                    </IconButton>
                  }
                  items={items(a)}
                />
              </span>
            </div>
          ))}
        </div>
      )}
      {confirmNode}
      <ResetPasswordDialog appId={appId} host={host.host} account={reset} onClose={() => setReset(null)} onDone={onChanged} />
    </Panel>
  );
}

type PwMode = "generate" | "choose";

function PasswordField({ mode, setMode, value, setValue, error, autoFocus }: { mode: PwMode; setMode: (m: PwMode) => void; value: string; setValue: (v: string) => void; error?: string | null; autoFocus?: boolean }) {
  return (
    <>
      <Field label="Password">
        <Segmented
          aria-label="Password"
          value={mode}
          onChange={setMode}
          options={[
            { value: "generate", label: "Make one up for me" },
            { value: "choose", label: "I'll choose it" },
          ]}
        />
      </Field>
      {mode === "choose" && (
        <Field label="New password" error={error} description="At least 8 characters. They can change it in their chat app.">
          <Input type="text" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoCapitalize="off" mono autoFocus={autoFocus} />
        </Field>
      )}
    </>
  );
}

export function AddAccountDialog({ open, onOpenChange, appId, host, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; host: string; onCreated: () => void }) {
  const [user, setUser] = React.useState("");
  const [role, setRole] = React.useState<"member" | "admin">("member");
  const [mode, setMode] = React.useState<PwMode>("generate");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [made, setMade] = React.useState<{ jid: string; password: string | null } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setUser("");
    setRole("member");
    setMode("generate");
    setPassword("");
    setErrors({});
    setGeneral(null);
    setMade(null);
  }, [open]);

  async function create() {
    const name = user.trim().toLowerCase();
    const e: Record<string, string> = {};
    if (!USERNAME_RE.test(name)) e.user = name ? "Use lowercase letters, numbers, dots, dashes or underscores." : "Choose a username.";
    if (mode === "choose" && password.length < 8) e.password = "Passwords are at least 8 characters.";
    setErrors(e);
    setGeneral(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api.post<{ jid: string; password: string | null }>(`${base(appId)}/accounts`, { host, user: name, role, password: mode === "choose" ? password : null });
      setMade({ jid: r.jid, password: r.password ?? (mode === "choose" ? password : null) });
      onCreated();
    } catch (err) {
      if (quiet(err)) return;
      if (err instanceof ApiError && err.field) setErrors({ [err.field]: err.message });
      else setGeneral(err instanceof Error ? err.message : "The account wasn't created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size={made ? "wide" : "default"}
      title={made ? "The account is ready" : "Add a chat account"}
      description={made ? "Send these to them, or let them scan the code." : `A new address on ${host}.`}
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
              Create account
            </Button>
          </>
        )
      }
    >
      {made ? (
        <Credentials appId={appId} jid={made.jid} password={made.password} />
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {general && (
            <Notice tone="fault" title="The account wasn't created">
              {general}
            </Notice>
          )}
          <Field label="Username" error={errors.user} description="What comes before the @. It can't be changed later.">
            <AffixInput
              after={`@${host}`}
              value={user}
              onChange={(e) => setUser(e.target.value.replace(/\s/g, "").toLowerCase())}
              autoFocus
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder="sam"
              mono
            />
          </Field>
          <PasswordField mode={mode} setMode={setMode} value={password} setValue={setPassword} error={errors.password} />
          <Field label="Role" description={role === "admin" ? "Can manage the server from a chat app that supports admin commands, like Gajim." : "Chats and joins group chats. Can't change the server."}>
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
        </form>
      )}
    </Dialog>
  );
}

function ResetPasswordDialog({ appId, host, account, onClose, onDone }: { appId: string; host: string; account: ChatAccount | null; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = React.useState<PwMode>("generate");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [made, setMade] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<ChatAccount | null>(null);
  const open = !!account;

  React.useEffect(() => {
    if (!account) return;
    setShown(account);
    setMode("generate");
    setPassword("");
    setError(null);
    setMade(null);
  }, [account]);

  async function go() {
    if (!shown) return;
    if (mode === "choose" && password.length < 8) {
      setError("Passwords are at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.patch<{ password: string | null }>(`${base(appId)}/accounts/${encodeURIComponent(shown.user)}`, { host, password: mode === "choose" ? password : "generate", signOut: true });
      setMade(r.password ?? password);
      onDone();
    } catch (e) {
      if (!quiet(e)) setError(e instanceof Error ? e.message : "The password wasn't changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      size={made ? "wide" : "default"}
      title={made ? "New password set" : `Reset ${shown?.user ?? ""}'s password`}
      description={made ? "Their devices were signed out. They sign in again with this password." : "Their devices are signed out, so a lost or shared phone loses access too."}
      footer={
        made ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void go()}>
              Reset password
            </Button>
          </>
        )
      }
    >
      {shown &&
        (made ? (
          <Credentials appId={appId} jid={shown.jid} password={made} />
        ) : (
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <PasswordField mode={mode} setMode={setMode} value={password} setValue={setPassword} error={error} autoFocus />
            {error && mode === "generate" && (
              <Notice tone="fault" title="The password wasn't changed">
                {error}
              </Notice>
            )}
          </form>
        ))}
    </Dialog>
  );
}
