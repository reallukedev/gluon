"use client";
import * as React from "react";
import { Plus, Xmark, Folder, ArrowRight } from "iconoir-react";
import type { Issue } from "@/lib/builder-types";
import type { Places } from "@/lib/files-types";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { FolderPicker } from "@/components/files/FolderPicker";
import { choosePendingFolder, parseVolumeString, setPendingFolders, setVolumes, volumeString, type ServiceForm, type VolumeRow } from "@/lib/builder/compose";
import { containerPathError, dataFolderError, dataFolderFor, hostPathError, mediaKind } from "@/lib/builder/names";
import { FieldNotes, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { useRows, writtenIndex } from "./useRows";
import s from "../builder.module.css";

const editable = (r: VolumeRow) => !(r.kind === "other" || r.kind === "named" || r.kind === "relative" || (r.long && r.raw !== null && r.kind !== "data" && r.kind !== "host"));
const complete = (r: VolumeRow) => !editable(r) || (!!r.source && !!r.target && !(r.kind === "data" ? dataFolderError(r.source) : hostPathError(r.source)) && !containerPathError(r.target));

/** Folders: app data (kept with the app) or a folder of this server, mounted somewhere in the app. */
export function VolumesGroup({ draft, form: f, issues, places, onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; places: Places | undefined; onFix: (id: string) => void }) {
  const base = `services.${f.name}.volumes`;
  const [picking, setPicking] = React.useState<number | null>(null);
  const [pickingFor, setPickingFor] = React.useState<string | null>(null);
  const [rows, setRows] = useRows<VolumeRow>(f.volumes, complete, (r) => (r.long || r.raw !== null || r.kind === "other" ? r : parseVolumeString(volumeString(r))), (done) => draft.editCompose((doc) => setVolumes(doc, f.name, done)));
  const written = writtenIndex(rows, complete);
  const set = (i: number, patch: Partial<VolumeRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dataFolders = () => new Set(rows.filter((r) => r.kind === "data").map((r) => r.source));

  return (
    <section className={s.group} data-field={base}>
      <div className={s.groupHead}>
        <h3 className={s.groupTitle}>Folders</h3>
        <span className={s.groupDesc}>App data is kept with the app and removed with it. Server folders are yours.</span>
      </div>
      {f.pendingFolders.map((t) => (
        <PendingFolder key={t} target={t} onChoose={(p) => draft.editCompose((doc) => choosePendingFolder(doc, f.name, t, p))} onPick={() => setPickingFor(t)} onSkip={() => draft.editCompose((doc) => setPendingFolders(doc, f.name, f.pendingFolders.filter((x) => x !== t)))} />
      ))}
      {rows.length > 0 && (
        <div className={s.rows}>
          <div className={`${s.rowHead} ${s.volRow}`} aria-hidden>
            <span>Kind</span>
            <span>Folder</span>
            <span />
            <span>In the app</span>
            <span />
            <span />
          </div>
          {rows.map((r, i) => {
            // Checks number the rows in the file; a half-typed row isn't there yet.
            const w = written[i];
            const at = w === null ? `${base}.typing-${i}` : `${base}.${w}`;
            const rowIssues = w === null ? [] : issuesAt(issues, at);
            if (!editable(r)) {
              return (
                <div key={i} className={s.stackTight} data-field={at}>
                  <div className={s.rawRow}>
                    <code className="mono">{r.raw ?? `${r.source}:${r.target}`}</code>
                    <IconButton label="Remove this folder" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <Xmark />
                    </IconButton>
                  </div>
                  <FieldNotes issues={rowIssues} errors onFix={onFix} />
                </div>
              );
            }
            const srcErr = r.source ? (r.kind === "data" ? dataFolderError(r.source) : hostPathError(r.source)) : null;
            const tgtErr = r.target ? containerPathError(r.target) : null;
            return (
              <div key={i} className={`${s.row} ${s.volRow}`} data-field={at}>
                <span className={s.volKind}>
                  <Select
                    className={s.fill}
                    value={r.kind}
                    onChange={(kind) => set(i, { kind, source: kind === "data" ? dataFolderFor(r.target || "/data", dataFolders()) : "" })}
                    options={[{ value: "data", label: "App data" }, { value: "host", label: "Server folder" }]}
                    aria-label="Kind of folder"
                  />
                </span>
                <span className={s.volSource}>
                  {r.kind === "data" ? (
                    <Input value={r.source} mono aria-label="Folder in the app's data" placeholder="config" onChange={(e) => set(i, { source: e.target.value })} aria-invalid={!!srcErr || undefined} title={`data/${r.source}`} />
                  ) : (
                    <span className={s.pathField}>
                      <Input value={r.source} mono aria-label="Folder on the server" placeholder="/mnt/media" onChange={(e) => set(i, { source: e.target.value })} aria-invalid={!!srcErr || undefined} title={r.source} />
                      <IconButton label="Choose a folder" onClick={() => setPicking(i)}>
                        <Folder />
                      </IconButton>
                    </span>
                  )}
                </span>
                <span className={s.arrow} aria-hidden>
                  <ArrowRight />
                </span>
                <span className={s.volTarget}>
                  <Input value={r.target} mono aria-label="Path in the app" placeholder="/config" onChange={(e) => set(i, { target: e.target.value })} aria-invalid={!!tgtErr || undefined} />
                </span>
                <span className={s.volRo}>
                  <Checkbox checked={r.readOnly} onChange={(readOnly) => set(i, { readOnly })}>
                    Read-only
                  </Checkbox>
                </span>
                <span className={s.remove}>
                  <IconButton label="Remove this folder" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Xmark />
                  </IconButton>
                </span>
                {(srcErr || tgtErr || rowIssues.length > 0) && (
                  <div className={s.rowNote}>
                    {(srcErr || tgtErr) && (
                      <p className={s.note} data-level="error">
                        {srcErr ?? tgtErr}
                      </p>
                    )}
                    <FieldNotes issues={rowIssues.filter((x) => x.level !== "error" || (!srcErr && !tgtErr))} errors onFix={onFix} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setRows([...rows, { kind: "data", source: "", target: "", readOnly: false, raw: null, long: false }])}>
        Add a folder
      </Button>
      <FolderPicker
        open={picking !== null}
        onOpenChange={(o) => !o && setPicking(null)}
        title="Choose a folder on the server"
        confirmLabel={(name) => `Use ${name}`}
        initialPath={picking !== null && rows[picking]?.source.startsWith("/") ? rows[picking]!.source : places?.places[0]?.path ?? "/"}
        places={places}
        onPick={(p) => picking !== null && set(picking, { source: p })}
      />
      <FolderPicker
        open={pickingFor !== null}
        onOpenChange={(o) => !o && setPickingFor(null)}
        title={pickingFor ? `Choose your ${mediaKind(pickingFor) ?? "media"} folder` : "Choose a folder"}
        confirmLabel={(name) => `Use ${name}`}
        initialPath={places?.places[0]?.path ?? "/"}
        places={places}
        onPick={(p) => {
          const t = pickingFor;
          if (t) draft.editCompose((doc) => choosePendingFolder(doc, f.name, t, p));
        }}
      />
    </section>
  );
}

/**
 * A media library the app expects (/music, /movies…). Gluon doesn't guess where it is: app data is
 * deleted with the app, so the person points it at a server folder before the app can start.
 */
function PendingFolder({ target, onChoose, onPick, onSkip }: { target: string; onChoose: (path: string) => void; onPick: () => void; onSkip: () => void }) {
  const [typed, setTyped] = React.useState("");
  const kind = mediaKind(target) ?? "media";
  const err = typed ? hostPathError(typed) : null;
  return (
    <div className={s.pendingFolder} data-field={`pending.${target}`}>
      <p className={s.pendingTitle}>
        Choose your {kind} folder <span className={s.muted}>for</span> <span className="mono">{target}</span>
      </p>
      <form
        className={s.pathField}
        onSubmit={(e) => {
          e.preventDefault();
          if (typed && !err) onChoose(typed);
        }}
      >
        <Input value={typed} mono aria-label={`Server folder for ${target}`} placeholder="/mnt/media/music" onChange={(e) => setTyped(e.target.value.trim())} aria-invalid={!!err || undefined} />
        <Button type="submit" disabled={!typed || !!err}>
          Use it
        </Button>
        <Button variant="primary" icon={<Folder />} onClick={onPick}>
          Choose a folder
        </Button>
      </form>
      {err ? (
        <p className={s.note} data-level="error">
          {err}
        </p>
      ) : (
        <p className={s.hint}>
          Your {kind} stays where it is, and stays put if you remove the app.{" "}
          <button type="button" className={s.link} onClick={onSkip}>
            The app doesn&apos;t need it
          </button>
        </p>
      )}
    </div>
  );
}
