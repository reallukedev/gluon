"use client";
import * as React from "react";
import { Plus, Xmark, Lock, Eye, EyeClosed } from "iconoir-react";
import type { Issue } from "@/lib/builder-types";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { setEnv, type EnvRow, type ServiceForm } from "@/lib/builder/compose";
import { envNameError, isLinuxServerImage, linuxServerEnv, looksSecret } from "@/lib/builder/names";
import { FieldNotes, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { useRows, writtenIndex } from "./useRows";
import s from "../builder.module.css";

interface PendingRow {
  key: string;
  value: string;
  secret: boolean;
  reveal?: boolean;
}

/**
 * Environment variables. Locked ones are secrets: encrypted on the server, never shown again,
 * and kept out of the compose file. `imageEnv` is what the image sets by default, offered for
 * the ones not here yet.
 */
export function EnvGroup({ draft, form: f, issues, imageEnv = [], onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; imageEnv?: { key: string; value: string }[]; onFix: (id: string) => void }) {
  const base = `services.${f.name}.env`;
  const secrets = draft.secrets[f.name] ?? [];
  const complete = (r: EnvRow) => !!r.key && !envNameError(r.key);
  const [rows, setRows] = useRows<EnvRow>(f.env, complete, (r) => r, (done) => draft.editCompose((doc) => setEnv(doc, f.name, done)));
  const written = writtenIndex(rows, complete);
  const [pending, setPending] = React.useState<PendingRow[]>([]);
  const [replacing, setReplacing] = React.useState<Record<string, string>>({});

  const has = (k: string) => rows.some((r) => r.key === k) || secrets.includes(k);
  const setPlain = (i: number, patch: Partial<EnvRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const makeSecret = (i: number) => {
    const r = rows[i]!;
    if (!r.key || envNameError(r.key)) return;
    draft.setSecret(f.name, r.key, r.value);
    setRows(rows.filter((_, j) => j !== i));
  };
  const unSecret = (key: string) => {
    draft.removeSecret(f.name, key);
    setRows([...rows, { key, value: "", interpolated: false }]);
  };
  const commitPending = (i: number) => {
    const p = pending[i]!;
    if (!p.key || envNameError(p.key)) return;
    if (p.secret) draft.setSecret(f.name, p.key, p.value);
    else setRows([...rows, { key: p.key, value: p.value, interpolated: false }]);
    setPending(pending.filter((_, j) => j !== i));
  };
  const finishReplace = (k: string, save: boolean) => {
    if (save) draft.setSecret(f.name, k, replacing[k]!);
    const { [k]: _, ...rest } = replacing;
    setReplacing(rest);
  };
  const missingLs = isLinuxServerImage(f.image) ? linuxServerEnv().filter((e) => !has(e.key)) : [];
  const missingImage = imageEnv.filter((e) => !has(e.key) && !looksSecret(e.key) && !missingLs.some((m) => m.key === e.key));
  const dupKey = (k: string, self: number) => rows.some((r, j) => j !== self && r.key === k) || secrets.includes(k);
  const addPlain = (list: { key: string; value: string }[]) => setRows([...rows, ...list.map((e) => ({ ...e, interpolated: false }))]);

  return (
    <section className={s.group} data-field={base}>
      <div className={s.groupHead}>
        <h3 className={s.groupTitle}>Environment</h3>
        <span className={s.groupDesc}>Locked values are secrets: encrypted, never shown again, and kept out of the compose file.</span>
      </div>
      {missingLs.length > 0 && (
        <p className={s.hint}>
          LinuxServer images read {missingLs.map((e) => e.key).join(", ")}.{" "}
          <button type="button" className={s.link} onClick={() => addPlain(missingLs)}>
            Add {missingLs.length > 1 ? "them" : "it"}
          </button>
        </p>
      )}
      {missingImage.length > 0 && (
        <p className={s.hint}>
          The image also sets <span className="mono">{missingImage.map((e) => e.key).join(", ")}</span> on its own.{" "}
          <button type="button" className={s.link} onClick={() => addPlain(missingImage)}>
            Show {missingImage.length > 1 ? "them" : "it"} here to change
          </button>
        </p>
      )}
      {(rows.length > 0 || secrets.length > 0 || pending.length > 0) && (
        <div className={s.rows}>
          {rows.map((r, i) => {
            // Checks number the rows in the file; a half-typed row isn't there yet.
            const w = written[i];
            const at = w === null ? `${base}.typing-${i}` : `${base}.${w}`;
            const rowIssues = w === null ? [] : issuesAt(issues, at);
            const nameErr = r.key ? envNameError(r.key) : null;
            const plainSecret = looksSecret(r.key) && !!r.value && !r.interpolated;
            return (
              <div key={`p${i}`} className={`${s.row} ${s.envRow}`} data-field={at}>
                <Input value={r.key} mono aria-label="Variable name" placeholder="NAME" onChange={(e) => setPlain(i, { key: e.target.value.replace(/\s/g, "") })} aria-invalid={!!nameErr || dupKey(r.key, i) || undefined} />
                <span className={s.envValue}>
                  <Input value={r.value} mono aria-label={`Value of ${r.key || "the variable"}`} placeholder="value" onChange={(e) => setPlain(i, { value: e.target.value })} title={r.interpolated ? "Uses compose variables" : undefined} />
                </span>
                <IconButton label={looksSecret(r.key) ? `Make ${r.key} a secret (recommended)` : `Make ${r.key || "it"} a secret`} onClick={() => makeSecret(i)} disabled={!r.key || !!nameErr} className={s.toggleOff}>
                  <Lock />
                </IconButton>
                <IconButton label="Remove this variable" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
                {(nameErr || rowIssues.length > 0 || r.interpolated || plainSecret) && (
                  <div className={s.rowNote}>
                    {nameErr && (
                      <p className={s.note} data-level="error">
                        {nameErr}
                      </p>
                    )}
                    {r.interpolated && <p className={s.note}>Compose fills in the variables in this value.</p>}
                    {plainSecret && (
                      <p className={s.note} data-level="warning">
                        <span>
                          This looks like a secret, and it&apos;s stored in the compose file as plain text.{" "}
                          <button type="button" className={s.link} onClick={() => makeSecret(i)}>
                            Make it a secret
                          </button>
                        </span>
                      </p>
                    )}
                    <FieldNotes issues={rowIssues} errors onFix={onFix} />
                  </div>
                )}
              </div>
            );
          })}
          {secrets.map((k) => {
            const editing = replacing[k] !== undefined;
            return (
              <div key={`s${k}`} className={`${s.row} ${s.envRow}`}>
                <Input value={k} mono readOnly aria-label="Secret name" />
                <span className={s.envValue}>
                  {editing ? (
                    <span className={s.pathField}>
                      <Input
                        value={replacing[k]!}
                        type="password"
                        mono
                        autoFocus
                        autoComplete="off"
                        aria-label={`New value of ${k}`}
                        placeholder="New value"
                        onChange={(e) => setReplacing({ ...replacing, [k]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            finishReplace(k, true);
                          }
                          if (e.key === "Escape") finishReplace(k, false);
                        }}
                      />
                      <Button onClick={() => finishReplace(k, true)}>Save</Button>
                    </span>
                  ) : (
                    <span className={s.secretValue}>
                      <span aria-label="Hidden value">••••••••</span>
                      <Button size="sm" variant="ghost" onClick={() => setReplacing({ ...replacing, [k]: "" })}>
                        Replace
                      </Button>
                    </span>
                  )}
                </span>
                <IconButton label={`Store ${k} in the compose file instead`} onClick={() => unSecret(k)} className={s.toggleOn}>
                  <Lock />
                </IconButton>
                <IconButton label={`Remove ${k}`} onClick={() => draft.removeSecret(f.name, k)}>
                  <Xmark />
                </IconButton>
              </div>
            );
          })}
          {pending.map((p, i) => (
            <PendingEnv key={`n${i}`} row={p} taken={(k) => dupKey(k, -1)} onChange={(r) => setPending(pending.map((x, j) => (j === i ? r : x)))} onCommit={() => commitPending(i)} onRemove={() => setPending(pending.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setPending([...pending, { key: "", value: "", secret: false }])}>
        Add a variable
      </Button>
    </section>
  );
}

/** A new variable: typed here, added once it has a valid name (and as a secret when locked). */
function PendingEnv({ row, taken, onChange, onCommit, onRemove }: { row: PendingRow; taken: (k: string) => boolean; onChange: (r: PendingRow) => void; onCommit: () => void; onRemove: () => void }) {
  const nameErr = row.key ? envNameError(row.key) ?? (taken(row.key) ? "That variable is already set." : null) : null;
  const ref = React.useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={`${s.row} ${s.envRow}`}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node) && row.key && !nameErr) onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && row.key && !nameErr) {
          e.preventDefault();
          onCommit();
        }
      }}
    >
      <Input value={row.key} mono autoFocus aria-label="Variable name" placeholder="NAME" onChange={(e) => onChange({ ...row, key: e.target.value.replace(/\s/g, ""), secret: row.secret || looksSecret(e.target.value) })} aria-invalid={!!nameErr || undefined} />
      <span className={s.envValue}>
        <span className={s.pathField}>
          <Input value={row.value} mono type={row.secret && !row.reveal ? "password" : "text"} autoComplete="off" aria-label="Value" placeholder={row.secret ? "Secret value" : "value"} onChange={(e) => onChange({ ...row, value: e.target.value })} />
          {row.secret && (
            <IconButton label={row.reveal ? "Hide the value" : "Show the value"} onClick={() => onChange({ ...row, reveal: !row.reveal })}>
              {row.reveal ? <EyeClosed /> : <Eye />}
            </IconButton>
          )}
        </span>
      </span>
      <IconButton label={row.secret ? "Keep it in the compose file" : "Make it a secret"} onClick={() => onChange({ ...row, secret: !row.secret })} className={row.secret ? s.toggleOn : s.toggleOff}>
        <Lock />
      </IconButton>
      <IconButton label="Remove this variable" onClick={onRemove}>
        <Xmark />
      </IconButton>
      {nameErr && (
        <div className={s.rowNote}>
          <p className={s.note} data-level="error">
            {nameErr}
          </p>
        </div>
      )}
    </div>
  );
}
