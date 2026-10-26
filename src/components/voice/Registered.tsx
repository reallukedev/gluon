"use client";
import * as React from "react";
import { MoreHoriz, Key, EditPencil, Trash, UserPlus } from "iconoir-react";
import type { VoiceDetails, VoiceRegistered } from "@/server/voice/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { ApiError } from "@/lib/client/api";
import { act, initial, quiet } from "./client";
import s from "./voice.module.css";

type Edit = { kind: "create" } | { kind: "rename"; r: VoiceRegistered } | { kind: "password"; r: VoiceRegistered };

/** People with a registered name on this server: their name is kept for them and they skip the join password. */
export function Registered({ appId, details, onChanged }: { appId: string; details: VoiceDetails | null; onChanged: () => void }) {
  const [confirm, confirmNode] = useConfirm();
  const [edit, setEdit] = React.useState<Edit | null>(null);
  const list = details?.registered ?? null;
  const su = list?.find((r) => r.id === 0) ?? null;
  const others = list?.filter((r) => r.id !== 0) ?? [];

  const askDelete = (r: VoiceRegistered) =>
    confirm({
      title: `Remove ${r.name}'s registration?`,
      consequences: [
        "Their name is free for anyone to take, and they need the join password again, if there is one.",
        "Their own permissions on channels are lost.",
        r.online ? "They stay connected for now, as a guest." : "They aren't connected right now.",
      ],
      confirmLabel: "Remove registration",
      variant: "dangerSolid",
      onConfirm: async () => {
        if (await act(appId, { op: "registered.delete", id: r.id })) onChanged();
      },
    });

  function items(r: VoiceRegistered): MenuEntry[] {
    if (r.id === 0) return [{ label: "Reset the admin (SuperUser) password…", icon: <Key />, onSelect: () => setEdit({ kind: "password", r }) }];
    return [
      { label: "Set a password…", icon: <Key />, onSelect: () => setEdit({ kind: "password", r }) },
      { label: "Rename…", icon: <EditPencil />, onSelect: () => setEdit({ kind: "rename", r }) },
      "separator",
      { label: "Remove registration…", icon: <Trash />, danger: true, onSelect: () => askDelete(r) },
    ];
  }

  const row = (r: VoiceRegistered) => (
    <li key={r.id} className={s.row}>
      <div className={s.who}>
        <span className={s.mark} aria-hidden>
          {initial(r.name)}
        </span>
        <div className={s.whoText}>
          <span className={s.name}>{r.name}</span>
          <span className={s.sub2}>
            {r.id === 0 ? (
              <span>Mumble&rsquo;s built-in admin. Sign in with this name and its password to manage permissions.</span>
            ) : (
              <>
                <span>{r.online ? "Here now" : r.lastActive ? <>Last here <Time ts={Date.parse(r.lastActive)} /></> : "Never connected"}</span>
                <span>{r.hasCertificate ? "Signs in with their Mumble app's certificate" : "Signs in with a password"}</span>
              </>
            )}
          </span>
        </div>
      </div>
      <Menu trigger={<IconButton label={`Actions for ${r.name}`} size="sm" variant="ghost"><MoreHoriz /></IconButton>} items={items(r)} />
    </li>
  );

  return (
    <Panel
      title="Registered people"
      meta={
        <Button size="sm" icon={<UserPlus />} onClick={() => setEdit({ kind: "create" })} disabled={!list}>
          Register
        </Button>
      }
      flush
    >
      {!list ? (
        <div className={s.empty} aria-busy="true">
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : (
        <>
          <ul className={s.list}>
            {others.map(row)}
            {su && row(su)}
          </ul>
          {others.length === 0 && (
            <div className={s.panelNote}>
            <p className={s.hint}>
              Nobody has registered yet. People register themselves from their Mumble app (Self › Register) once they&rsquo;re connected, or you can register someone here with a password.
            </p>
          </div>
          )}
        </>
      )}
      <EditDialog appId={appId} edit={edit} onClose={() => setEdit(null)} onDone={onChanged} />
      {confirmNode}
    </Panel>
  );
}

function EditDialog({ appId, edit, onClose, onDone }: { appId: string; edit: Edit | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const last = React.useRef(edit);
  if (edit) last.current = edit;
  const e = edit ?? last.current;

  React.useEffect(() => {
    if (!edit) return;
    setError(null);
    setPassword("");
    setName(edit.kind === "rename" ? edit.r.name : "");
  }, [edit]);

  const su = e?.kind === "password" && e.r.id === 0;
  const title = !e ? "" : e.kind === "create" ? "Register someone" : e.kind === "rename" ? `Rename ${e.r.name}` : su ? "Reset the admin (SuperUser) password" : `New password for ${e.r.name}`;
  const needsName = e?.kind !== "password";
  const needsPassword = e?.kind !== "rename";
  const ready = (!needsName || name.trim().length > 0) && (!needsPassword || password.length >= 8);

  async function save() {
    if (!e || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const op =
        e.kind === "create"
          ? ({ op: "registered.create", name, password } as const)
          : e.kind === "rename"
            ? ({ op: "registered.rename", id: e.r.id, name } as const)
            : ({ op: "registered.password", id: e.r.id, password } as const);
      if (await act(appId, op, { inline: true })) {
        onDone();
        onClose();
      }
    } catch (err) {
      if (!quiet(err)) setError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: "That didn't work." });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (f: string) => (error && (error.field === f || (!error.field && f === (needsPassword ? "password" : "name"))) ? error.message : null);

  return (
    <Dialog
      open={!!edit}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={
        e?.kind === "create"
          ? "They sign in with this name and password; their Mumble app then remembers them."
          : su
            ? "SuperUser can change permissions and channels from any Mumble app. Gluon doesn't keep this password, so save it somewhere safe."
            : e?.kind === "password"
              ? "They type it the next time their Mumble app asks. A certificate they already use keeps working."
              : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()}>
            {e?.kind === "create" ? "Register" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className={s.dialogStack}
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        {needsName && (
          <Field label="Name" error={fieldError("name")}>
            <Input value={name} onChange={(ev) => setName(ev.target.value)} maxLength={128} autoFocus autoComplete="off" spellCheck={false} />
          </Field>
        )}
        {needsPassword && (
          <Field label="Password" error={fieldError("password")} description="At least 8 characters.">
            <Input type="password" value={password} onChange={(ev) => setPassword(ev.target.value)} maxLength={128} autoFocus={!needsName} autoComplete="new-password" />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
