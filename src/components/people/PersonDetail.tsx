"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHoriz, EditPencil, Lock, ShieldCheck, Pause, Play, Trash, Refresh } from "iconoir-react";
import type { FolderGrant, PersonSession, PersonView } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Notice, Page, PageHeader, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Menu } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AccessMap } from "./AccessMap";
import { Avatar, device, errorMessage, roleLabel } from "./bits";
import s from "./people.module.css";

interface DetailPayload {
  person: PersonView;
  sessions: PersonSession[];
  grants: FolderGrant[];
  apps: string[];
}

export function PersonDetail({ initial }: { initial: PersonView }) {
  const router = useRouter();
  const url = `/api/people/${encodeURIComponent(initial.id)}`;
  const { data, error, mutate } = useApi<DetailPayload>(url, { refresh: 30_000 });
  const p = data?.person ?? initial;
  const [confirm, confirmNode] = useConfirm();
  const [pwOpen, setPwOpen] = React.useState(false);
  const [nameOpen, setNameOpen] = React.useState(false);
  const member = p.role === "member";

  async function patch(body: Record<string, unknown>, done: string) {
    await api.patch(url, body);
    toast.success(done);
    void mutate();
    router.refresh();
  }
  const quiet = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      throw e;
    }
  };

  const changeRole = (role: "admin" | "member") =>
    confirm({
      title: role === "admin" ? `Make ${p.displayName} an admin?` : `Make ${p.displayName} a household member?`,
      consequences:
        role === "admin"
          ? ["They can change everything on the server: apps, disks, public addresses, other people's accounts.", "Their individual app and folder choices are cleared (admins see everything).", ...(p.mfa ? [] : ["They'll need two-step verification to sign in from outside home."])]
          : ["They lose access to everything except their apps, Status, and any folders you share.", ...(p.self ? ["That's you: you'll lose admin access straight away."] : [])],
      confirmLabel: role === "admin" ? "Make admin" : "Make household member",
      variant: "primary",
      onConfirm: quiet(() => patch({ role }, role === "admin" ? `${p.displayName} is now an admin` : `${p.displayName} is now in the household`)),
    });
  const toggleDisabled = () =>
    confirm({
      title: p.disabled ? `Turn ${p.displayName}'s account back on?` : `Turn off ${p.displayName}'s account?`,
      consequences: p.disabled
        ? ["They can sign in again with their existing password."]
        : ["They're signed out everywhere and can't sign in.", "Their settings, apps and folders are kept for when you turn it back on."],
      confirmLabel: p.disabled ? "Turn on" : "Turn off",
      variant: p.disabled ? "primary" : "dangerSolid",
      onConfirm: quiet(() => patch({ disabled: !p.disabled }, p.disabled ? "Account turned on" : "Account turned off")),
    });
  const resetMfa = () =>
    confirm({
      title: `Turn off two-step verification for ${p.displayName}?`,
      description: "Use this when someone lost their phone.",
      consequences: ["Their password alone is enough to sign in until they set it up again.", "Their old recovery codes stop working.", ...(p.role === "admin" ? ["As an admin, they can only sign in from home until they set it up again."] : [])],
      confirmLabel: "Turn off two-step",
      onConfirm: quiet(async () => {
        await api.del(`${url}/mfa`);
        toast.success("Two-step verification turned off", { description: `Ask ${p.displayName} to set it up again in Settings → Security.` });
        void mutate();
      }),
    });
  const remove = () =>
    confirm({
      title: `Remove ${p.displayName}?`,
      consequences: [
        "Their account is deleted and they're signed out everywhere.",
        "Their app and folder access, notification channels and home page are deleted.",
        "Files they made stay where they are. Their problem reports stay, without their name.",
        "This can't be undone. You can invite them again later.",
      ],
      typeToConfirm: p.username,
      confirmLabel: "Remove person",
      onConfirm: quiet(async () => {
        await api.del(url);
        toast.success(`Removed ${p.displayName}`);
        router.push("/people");
        router.refresh();
      }),
    });

  const summary = (
    <span className={s.summary}>
      {p.disabled ? <StateLine state="stopped" label="Turned off" /> : <StateLine state="running" label={roleLabel(p.role)} />}
      <span className={s.muted}>
        <span className="mono">{p.username}</span> · two-step {p.mfa ? "on" : "off"} ·{" "}
        {p.lastSeenAt ? (
          <>
            seen <Time ts={p.lastSeenAt} />
          </>
        ) : (
          "not signed in"
        )}
      </span>
    </span>
  );

  return (
    <Page>
      <PageHeader
        back={{ href: "/people", label: "People" }}
        title={
          <span className={s.title}>
            <Avatar name={p.displayName} size={40} off={p.disabled} />
            <span className="truncate">{p.displayName}</span>
          </span>
        }
        summary={summary}
        actions={
          <>
            {!p.self && (
              <Button icon={<Lock />} onClick={() => setPwOpen(true)}>
                Set a new password
              </Button>
            )}
            <Menu
              trigger={
                <IconButton label="More actions" variant="secondary">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                { label: "Rename", icon: <EditPencil />, onSelect: () => setNameOpen(true) },
                ...(!p.self && p.mfa ? [{ label: "Turn off two-step", description: "When they lost their phone", icon: <ShieldCheck />, onSelect: resetMfa }] : []),
                ...(!p.self ? [p.disabled ? { label: "Turn account on", icon: <Play />, onSelect: toggleDisabled } : { label: "Turn account off", icon: <Pause />, onSelect: toggleDisabled }] : []),
                ...(!p.self ? ["separator" as const, { label: "Remove person", icon: <Trash />, danger: true, onSelect: remove }] : []),
              ]}
            />
          </>
        }
      />

      {error && !data && (
        <div style={{ marginBottom: 20 }}>
          <Notice tone="fault" title="Couldn't load everything about this person">
            {error.message}
          </Notice>
        </div>
      )}
      {p.mustChangePassword && (
        <div style={{ marginBottom: 20 }}>
          <Notice title="Waiting for a new password">They'll be asked to choose their own password the next time they sign in.</Notice>
        </div>
      )}

      <div className={s.grid}>
        <Panel title="Account">
          <dl className={s.kv}>
            <dt>Role</dt>
            <dd>
              {p.self ? (
                roleLabel(p.role)
              ) : (
                <Segmented
                  aria-label="Role"
                  value={p.role}
                  onChange={(v) => v !== p.role && changeRole(v)}
                  options={[
                    { value: "member", label: "Household" },
                    { value: "admin", label: "Admin" },
                  ]}
                />
              )}
            </dd>
            <dt>Two-step</dt>
            <dd>
              {p.mfa ? (
                <StateLine state="running" label="On: a code from their phone too" />
              ) : p.role === "admin" ? (
                <StateLine state="attention" label="Off: can only sign in at home" />
              ) : (
                <StateLine state="stopped" label="Off: password only" />
              )}
            </dd>
            <dt>Joined</dt>
            <dd>
              <Time ts={p.createdAt} kind="date" />
            </dd>
            <dt>Last signed in</dt>
            <dd>{p.lastLoginAt ? <Time ts={p.lastLoginAt} kind="dateTime" /> : <span className={s.muted}>Never</span>}</dd>
          </dl>
        </Panel>

        <Sessions url={url} sessions={data?.sessions} self={p.self} name={p.displayName} onChange={() => void mutate()} />

        <div className={s.span2}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>What {p.displayName} can open</h2>
            {member && <span className={s.hint}>Changes apply straight away.</span>}
          </div>
          {member ? <AccessMap memberId={p.id} /> : <Panel><p className={s.hint}>Admins open every app and every folder, so there's nothing to choose. Make {p.displayName} a household member to limit what they can open.</p></Panel>}
        </div>
      </div>

      <PasswordDialog open={pwOpen} onOpenChange={setPwOpen} url={url} name={p.displayName} onDone={() => void mutate()} />
      <RenameDialog open={nameOpen} onOpenChange={setNameOpen} current={p.displayName} onSave={(name) => patch({ displayName: name }, "Renamed")} />
      {confirmNode}
    </Page>
  );
}

function Sessions({ url, sessions, self, name, onChange }: { url: string; sessions: PersonSession[] | undefined; self: boolean; name: string; onChange: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  async function revoke(body: { id: string } | { all: true }) {
    setBusy("id" in body ? body.id : "all");
    try {
      const r = await api.del<{ revoked: number }>(`${url}/sessions`, body);
      toast.success("all" in body ? `Signed out of ${r.revoked} device${r.revoked === 1 ? "" : "s"}` : "Signed out of that device");
      onChange();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const others = sessions?.filter((x) => !x.current) ?? [];
  return (
    <Panel
      title="Signed-in devices"
      meta={
        others.length > 1 ? (
          <Button size="sm" loading={busy === "all"} onClick={() => void revoke({ all: true })}>
            Sign out everywhere
          </Button>
        ) : undefined
      }
      flush
    >
      {!sessions ? (
        <div className={s.skeletons}>
          <Skeleton height={32} />
        </div>
      ) : sessions.length === 0 ? (
        <p className={`${s.pad} ${s.muted}`}>{name} isn't signed in anywhere.</p>
      ) : (
        <ul className={s.sessions} role="list">
          {sessions.map((x) => (
            <li key={x.id}>
              <span className={s.sessionText}>
                <span className={s.sessionName}>
                  {device(x.userAgent)}
                  {x.current && <span className={s.muted}> · this device</span>}
                </span>
                <span className={s.sessionSub}>
                  {x.zone === "home" ? "At home" : "Away"}
                  {x.ip ? <span className="mono"> · {x.ip}</span> : null} · active <Time ts={x.lastSeenAt} />
                </span>
              </span>
              {!x.current && (
                <Button size="sm" variant="ghost" loading={busy === x.id} onClick={() => void revoke({ id: x.id })}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {self && sessions && sessions.length > 0 && <p className={`${s.pad} ${s.hint}`}>Your own devices are also in Settings → Security.</p>}
    </Panel>
  );
}

/** Ten characters from an unambiguous alphabet plus a dash, easy to read out loud. */
function tempPassword(): string {
  const alpha = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => alpha[b % alpha.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function PasswordDialog({ open, onOpenChange, url, name, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; url: string; name: string; onDone: () => void }) {
  const [pw, setPw] = React.useState("");
  const [must, setMust] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setPw(tempPassword());
      setMust(true);
      setErr(null);
      setDone(false);
    }
  }, [open]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`${url}/password`, { password: pw, mustChange: must });
      setDone(true);
      onDone();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={done ? "New password set" : `Set a new password for ${name}`}
      description={done ? undefined : "Use this when someone forgot theirs. They're signed out everywhere."}
      footer={
        done ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Set password
            </Button>
          </>
        )
      }
    >
      <div className={s.form}>
        {done ? (
          <>
            <p className={s.hint}>Give {name} this password{must ? ". They'll choose their own when they sign in." : "."}</p>
            <div className={s.link}>
              <Input mono readOnly value={pw} aria-label="New password" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={pw} size="md">
                Copy
              </CopyButton>
            </div>
          </>
        ) : (
          <>
            <Field label="Temporary password" error={err}>
              <div className={s.link}>
                <Input mono value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" spellCheck={false} />
                <IconButton label="Make another" variant="secondary" onClick={() => setPw(tempPassword())}>
                  <Refresh />
                </IconButton>
              </div>
            </Field>
            <Checkbox checked={must} onChange={setMust}>
              Ask them to choose their own password when they sign in
            </Checkbox>
          </>
        )}
      </div>
    </Dialog>
  );
}

function RenameDialog({ open, onOpenChange, current, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; current: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName(current);
      setErr(null);
    }
  }, [open, current]);
  async function save() {
    setBusy(true);
    try {
      await onSave(name.trim());
      onOpenChange(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || name.trim() === current} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={err} description="What Gluon calls them. Their username doesn't change.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}
