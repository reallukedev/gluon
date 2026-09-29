"use client";
import * as React from "react";
import { Plus, Xmark, Lock, LockSlash, Folder, MoreHoriz, Eye, EyeClosed } from "iconoir-react";
import type { BuilderSource, BuilderTarget, Issue, SecretNames } from "@/lib/builder-types";
import type { Places } from "@/lib/files-types";
import { useApi } from "@/lib/client/api";
import { Panel, Notice, Empty } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input, Switch, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Menu } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { FolderPicker } from "@/components/files/FolderPicker";
import {
  addService, parsePortString, portString, removeService, renameService, setBuild, setCommand, setDependsOn, setDevices, setEnv, setHealth, setHostNetwork,
  setImage, setMemory, setPorts, setPrivileged, setRestart, setUser, setVolumes, parseVolumeString, volumeString,
  type EnvRow, type HealthForm, type PortRow, type ServiceForm, type VolumeRow,
} from "@/lib/builder/compose";
import { containerPathError, dataFolderError, envNameError, hostPathError, looksSecret, serviceNameError, DEVICE_RE, memoryError } from "@/lib/builder/names";
import { pickWebPort } from "@/lib/builder/start";
import { ImageField, useImageLookup } from "./ImageField";
import { FieldNotes, errorAt, issuesAt } from "./Issues";
import type { Draft } from "./state";
import s from "./builder.module.css";

interface Props {
  draft: Draft;
  services: ServiceForm[];
  issues: Issue[];
  target: BuilderTarget;
  source: BuilderSource;
  yamlBroken: boolean;
  onFix: (fixId: string) => void;
  onOpenCompose: () => void;
}

export function ServicesTab({ draft, services, issues, target, source, yamlBroken, onFix, onOpenCompose }: Props) {
  const [adding, setAdding] = React.useState(false);
  const { data: places } = useApi<Places>("/api/files/places", { revalidateOnFocus: false });
  if (yamlBroken) {
    return (
      <Notice tone="fault" title="The compose file has an error" action={<Button size="sm" onClick={onOpenCompose}>Open Compose</Button>}>
        Fix it in Compose first; the form can only edit a file it can read.
      </Notice>
    );
  }
  const names = services.map((x) => x.name);
  return (
    <>
      {services.length === 0 && (
        <Empty title="No services yet" action={<Button icon={<Plus />} onClick={() => setAdding(true)}>Add a service</Button>}>
          A service is one container. Most apps need one; some add a database or a cache.
        </Empty>
      )}
      {services.map((f) => (
        <ServiceEditor key={f.name} draft={draft} form={f} names={names} issues={issuesAt(issues, `services.${f.name}`, true)} allIssues={issues} target={target} source={source} places={places} onFix={onFix} />
      ))}
      {services.length > 0 && (
        <div>
          <Button icon={<Plus />} onClick={() => setAdding(true)}>
            Add a service
          </Button>
        </div>
      )}
      <NameDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a service"
        confirm="Add"
        taken={names}
        initial={names.length ? (names.includes("db") ? "" : "db") : "app"}
        onDone={(name) => {
          draft.editCompose((doc) => addService(doc, name));
          if (!draft.spec.web.service && !names.length) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: name } }));
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- rows that may be half-typed

/**
 * Rows the form edits locally and writes to the compose file once they're complete, so a
 * half-typed port doesn't turn into nonsense in the file (or vanish while you type).
 */
function useRows<T>(fromDoc: T[], complete: (r: T) => boolean, normalize: (r: T) => T, write: (rows: T[]) => void) {
  const [rows, setRows] = React.useState<T[]>(fromDoc);
  const written = React.useRef(JSON.stringify(fromDoc));
  const key = JSON.stringify(fromDoc);
  React.useEffect(() => {
    if (key !== written.current) {
      written.current = key;
      setRows(fromDoc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = (next: T[]) => {
    setRows(next);
    const done = next.filter(complete);
    const norm = done.map(normalize);
    const k = JSON.stringify(norm);
    if (k !== written.current) {
      written.current = k;
      write(done);
    }
  };
  return [rows, update] as const;
}

// ---------------------------------------------------------------- one service

function ServiceEditor({ draft, form: f, names, issues, allIssues, target, source, places, onFix }: { draft: Draft; form: ServiceForm; names: string[]; issues: Issue[]; allIssues: Issue[]; target: BuilderTarget; source: BuilderSource; places: Places | undefined; onFix: (id: string) => void }) {
  const edit = (fn: (doc: import("yaml").Document) => void) => draft.editCompose(fn);
  const isWeb = draft.spec.web.service === f.name;
  const [renaming, setRenaming] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const lookup = useImageLookup(f.build ? "" : f.image);
  const secretKeys = draft.secrets[f.name] ?? [];
  const base = `services.${f.name}`;

  const remove = () =>
    confirm({
      title: `Remove “${f.name}”?`,
      description: "It's removed from this app's compose file. Nothing changes where the app runs until you publish.",
      consequences: [
        ...(isWeb ? ["The app won't have a web page until you choose another service."] : []),
        ...(secretKeys.length ? [`Its ${secretKeys.length === 1 ? "secret" : `${secretKeys.length} secrets`} (${secretKeys.join(", ")}) ${secretKeys.length === 1 ? "is" : "are"} deleted.`] : []),
        "Its data folders stay in the app's data folder.",
      ],
      confirmLabel: "Remove service",
      variant: "danger",
      onConfirm: () => {
        edit((doc) => removeService(doc, f.name));
        for (const k of secretKeys) draft.removeSecret(f.name, k);
        if (isWeb) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: null, containerPort: null } }));
      },
    });

  const applyHints = () => {
    const r = lookup.result;
    if (!r) return;
    const web = pickWebPort(r.ports);
    edit((doc) => {
      const ports = r.ports.filter((p) => !(isWeb && p.port === web && target === "umbrel")).filter((p) => !f.ports.some((q) => q.container === p.port));
      if (ports.length) setPorts(doc, f.name, [...f.ports, ...ports.map((p) => ({ host: p.port, container: p.port, proto: p.proto, ip: "", raw: null }))]);
      const vols = r.volumes.filter((v) => !f.volumes.some((x) => x.target === v)).map((v) => ({ kind: "data" as const, source: v.replace(/^\/+/, "").split("/").slice(-2).join("-").replace(/[^A-Za-z0-9._-]+/g, "-") || "data", target: v, readOnly: false, raw: null, long: false }));
      if (vols.length) setVolumes(doc, f.name, [...f.volumes, ...vols]);
    });
    if (isWeb && web && !draft.spec.web.containerPort) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, containerPort: web, port: sp.web.port ?? web } }));
  };
  const suggestable = !!lookup.result?.exists && ((lookup.result.ports.some((p) => !f.ports.some((q) => q.container === p.port) && !(isWeb && p.port === draft.spec.web.containerPort))) || lookup.result.volumes.some((v) => !f.volumes.some((x) => x.target === v)));

  return (
    <Panel
      title={
        <span className={s.serviceHead}>
          <span className={s.serviceName} title={f.name}>
            {f.name}
          </span>
          {isWeb && <span className={s.webTag}>web page</span>}
        </span>
      }
      meta={
        <Menu
          trigger={
            <IconButton label={`More for ${f.name}`} size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={[
            { label: "Rename", onSelect: () => setRenaming(true) },
            ...(!isWeb ? [{ label: "Make this the web page", onSelect: () => draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: f.name, containerPort: f.ports.find((p) => p.container && p.proto === "tcp")?.container ?? lookup.result?.ports[0]?.port ?? sp.web.containerPort } })) }] : []),
            "separator",
            { label: "Remove service", danger: true, onSelect: remove },
          ]}
        />
      }
      flush
    >
      {/* ---------------- image or build */}
      <section className={s.group} data-field={`${base}.image`}>
        {f.build ? (
          <>
            <div className={s.groupHead}>
              <h3 className={s.groupTitle}>Built from the repository</h3>
              {source !== "github" && <span className={s.note} data-level="error">Only apps from GitHub can build.</span>}
            </div>
            <div className={s.twoCol}>
              <Field label="Folder" description="Relative to the app's folder in the repository." error={errorAt(issues, `${base}.build`)}>
                <Input value={f.build.context} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, context: e.target.value }))} placeholder="." />
              </Field>
              <Field label="Dockerfile" optional>
                <Input value={f.build.dockerfile} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, dockerfile: e.target.value }))} placeholder="Dockerfile" />
              </Field>
              <Field label="Build stage" optional description="A target in a multi-stage Dockerfile.">
                <Input value={f.build.target} mono onChange={(e) => edit((doc) => setBuild(doc, f.name, { ...f.build!, target: e.target.value }))} />
              </Field>
            </div>
          </>
        ) : (
          <ImageField value={f.image} onChange={(v) => edit((doc) => setImage(doc, f.name, v))} lookup={lookup} error={errorAt(issues, `${base}.image`)}>
            {suggestable && (
              <div className={s.imageStatus}>
                <span>
                  The image also asks for{" "}
                  {[lookup.result!.ports.length ? `port${lookup.result!.ports.length > 1 ? "s" : ""} ${lookup.result!.ports.map((p) => p.port).join(", ")}` : null, lookup.result!.volumes.length ? `folder${lookup.result!.volumes.length > 1 ? "s" : ""} ${lookup.result!.volumes.join(", ")}` : null].filter(Boolean).join(" and ")}
                  .
                </span>
                <button type="button" className={s.link} onClick={applyHints}>
                  Add {lookup.result!.ports.length + lookup.result!.volumes.length > 1 ? "them" : "it"}
                </button>
              </div>
            )}
          </ImageField>
        )}
        <FieldNotes issues={issuesAt(issues, `${base}.image`)} />
      </section>

      <PortsGroup draft={draft} form={f} issues={issues} isWeb={isWeb} target={target} onFix={onFix} />
      <VolumesGroup draft={draft} form={f} issues={issues} places={places} onFix={onFix} />
      <EnvGroup draft={draft} form={f} issues={issues} onFix={onFix} />
      <AdvancedGroup draft={draft} form={f} names={names} issues={issues} allIssues={allIssues} />

      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={`Rename “${f.name}”`}
        confirm="Rename"
        taken={names.filter((n) => n !== f.name)}
        initial={f.name}
        description="Other services reach it by this name (it's its hostname), so update any addresses that use the old one."
        onDone={async (name) => {
          if (name === f.name) return;
          if (secretKeys.length) await draft.renameSecrets(f.name, name);
          edit((doc) => renameService(doc, f.name, name));
          if (isWeb) draft.setSpec((sp) => ({ ...sp, web: { ...sp.web, service: name } }));
        }}
      />
      {confirmNode}
    </Panel>
  );
}

// ---------------------------------------------------------------- ports

function PortsGroup({ draft, form: f, issues, isWeb, target, onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; isWeb: boolean; target: BuilderTarget; onFix: (id: string) => void }) {
  const base = `services.${f.name}.ports`;
  const [rows, setRows] = useRows<PortRow>(
    f.ports,
    (r) => r.raw !== null || (!!r.container && r.container > 0 && r.container < 65536 && (r.host === null || (r.host > 0 && r.host < 65536))),
    (r) => (r.raw !== null ? r : parsePortString(portString(r))),
    (done) => draft.editCompose((doc) => setPorts(doc, f.name, done)),
  );
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "").slice(0, 5)) || null);
  const set = (i: number, patch: Partial<PortRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const web = draft.spec.web;

  return (
    <section className={s.group} data-field={base}>
      <div className={s.groupHead}>
        <h3 className={s.groupTitle}>Ports</h3>
        {f.hostNetwork && <span className={s.groupDesc}>Uses the server&apos;s network, so every port it opens is on the server already.</span>}
      </div>
      {isWeb && web.containerPort && !f.hostNetwork && (
        <p className={s.hint}>
          Its web page (port <span className="mono">{web.containerPort}</span>) opens on <span className="mono">{web.port ?? "?"}</span>
          {target === "umbrel" ? " through Umbrel's proxy" : ""}; it doesn&apos;t need a row here. Add ports other devices connect to directly.
        </p>
      )}
      {rows.length > 0 && !f.hostNetwork && (
        <div className={s.rows}>
          <div className={`${s.rowHead} ${s.portRow}`} aria-hidden>
            <span>On the server</span>
            <span />
            <span>In the app</span>
            <span />
            <span />
          </div>
          {rows.map((r, i) => {
            const at = `${base}.${i}`;
            const rowIssues = issuesAt(issues, at);
            if (r.raw !== null) {
              return (
                <div key={i} className={s.stack} style={{ gap: 4 }} data-field={at}>
                  <div className={s.rawRow}>
                    <code className="mono">{r.raw}</code>
                    <IconButton label="Remove this port" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                      <Xmark />
                    </IconButton>
                  </div>
                  <FieldNotes issues={rowIssues} errors onFix={onFix} />
                </div>
              );
            }
            const err = rowIssues.find((x) => x.level === "error");
            return (
              <div key={i} className={`${s.row} ${s.portRow}`} data-field={at}>
                <Input value={r.host ?? ""} inputMode="numeric" mono aria-label="Port on the server" placeholder="auto" onChange={(e) => set(i, { host: num(e.target.value) })} aria-invalid={!!err || undefined} />
                <span className={s.arrow} aria-hidden>
                  →
                </span>
                <Input value={r.container ?? ""} inputMode="numeric" mono aria-label="Port in the app" placeholder="80" onChange={(e) => set(i, { container: num(e.target.value) })} aria-invalid={!r.container || undefined} />
                <span className={s.proto}>
                  <Select className={s.fill} value={r.proto} onChange={(proto) => set(i, { proto })} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} aria-label="Protocol" />
                </span>
                <IconButton label="Remove this port" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
                {rowIssues.length > 0 && (
                  <div className={s.rowNote}>
                    <FieldNotes issues={rowIssues} errors onFix={onFix} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!f.hostNetwork && (
        <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setRows([...rows, { host: null, container: null, proto: "tcp", ip: "", raw: null }])}>
          Add a port
        </Button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- folders

function VolumesGroup({ draft, form: f, issues, places, onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; places: Places | undefined; onFix: (id: string) => void }) {
  const base = `services.${f.name}.volumes`;
  const [picking, setPicking] = React.useState<number | null>(null);
  const [rows, setRows] = useRows<VolumeRow>(
    f.volumes,
    (r) => r.kind === "other" || r.kind === "named" || r.kind === "relative" || (!!r.source && !!r.target && !(r.kind === "data" ? dataFolderError(r.source) : hostPathError(r.source)) && !containerPathError(r.target)),
    (r) => (r.long || r.raw !== null || r.kind === "other" ? r : parseVolumeString(volumeString(r))),
    (done) => draft.editCompose((doc) => setVolumes(doc, f.name, done)),
  );
  const set = (i: number, patch: Partial<VolumeRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className={s.group} data-field={base}>
      <div className={s.groupHead}>
        <h3 className={s.groupTitle}>Folders</h3>
        <span className={s.groupDesc}>App data is kept with the app and removed with it; server folders are yours.</span>
      </div>
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
            const at = `${base}.${i}`;
            const rowIssues = issuesAt(issues, at);
            if (r.kind === "other" || r.kind === "named" || r.kind === "relative" || (r.long && r.raw !== null && r.kind !== "data" && r.kind !== "host")) {
              return (
                <div key={i} className={s.stack} style={{ gap: 4 }} data-field={at}>
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
                    onChange={(kind) => set(i, { kind, source: kind === "data" ? r.target.replace(/^\/+/, "").split("/").pop() || "data" : "" })}
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
                  →
                </span>
                <span className={s.volTarget}>
                  <Input value={r.target} mono aria-label="Path in the app" placeholder="/config" onChange={(e) => set(i, { target: e.target.value })} aria-invalid={!!tgtErr || undefined} />
                </span>
                <span className={s.volRo} style={{ alignSelf: "center" }}>
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
    </section>
  );
}

// ---------------------------------------------------------------- environment

interface EnvUiRow {
  key: string;
  value: string;
  interpolated: boolean;
  secret: boolean;
  /** A secret whose value is saved (and not shown). */
  saved: boolean;
  reveal?: boolean;
}

function EnvGroup({ draft, form: f, issues, onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; onFix: (id: string) => void }) {
  const base = `services.${f.name}.env`;
  const secrets = draft.secrets[f.name] ?? [];
  const [rows, setRowsRaw] = useRows<EnvRow>(
    f.env,
    (r) => !!r.key && !envNameError(r.key),
    (r) => r,
    (done) => draft.editCompose((doc) => setEnv(doc, f.name, done)),
  );
  const [pending, setPending] = React.useState<EnvUiRow[]>([]);
  const [replacing, setReplacing] = React.useState<Record<string, string>>({});
  const plain = rows.map((r) => ({ ...r, secret: false, saved: false }));

  const setPlain = (i: number, patch: Partial<EnvRow>) => setRowsRaw(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const makeSecret = (i: number) => {
    const r = rows[i]!;
    if (!r.key || envNameError(r.key)) return;
    draft.setSecret(f.name, r.key, r.value);
    setRowsRaw(rows.filter((_, j) => j !== i));
  };
  const unSecret = (key: string) => {
    draft.removeSecret(f.name, key);
    setRowsRaw([...rows, { key, value: "", interpolated: false }]);
  };
  const commitPending = (i: number) => {
    const p = pending[i]!;
    if (!p.key || envNameError(p.key)) return;
    if (p.secret) draft.setSecret(f.name, p.key, p.value);
    else setRowsRaw([...rows, { key: p.key, value: p.value, interpolated: false }]);
    setPending(pending.filter((_, j) => j !== i));
  };
  const lsio = /(^|\/)linuxserver\/|^lscr\.io\//.test(f.image);
  const missingLs = lsio ? ["PUID", "PGID", "TZ"].filter((k) => !rows.some((r) => r.key === k) && !secrets.includes(k)) : [];
  const dupKey = (k: string, self: number) => rows.some((r, j) => j !== self && r.key === k) || secrets.includes(k);

  return (
    <section className={s.group} data-field={base}>
      <div className={s.groupHead}>
        <h3 className={s.groupTitle}>Environment</h3>
        <span className={s.groupDesc}>Locked values are secrets: encrypted, never shown again, and kept out of the compose file.</span>
      </div>
      {missingLs.length > 0 && (
        <p className={s.hint}>
          LinuxServer images read {missingLs.join(", ")}.{" "}
          <button
            type="button"
            className={s.link}
            onClick={() => {
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
              const add = missingLs.map((k) => ({ key: k, value: k === "TZ" ? tz : "1000", interpolated: false }));
              setRowsRaw([...rows, ...add]);
            }}
          >
            Add {missingLs.length > 1 ? "them" : "it"}
          </button>
        </p>
      )}
      {(plain.length > 0 || secrets.length > 0 || pending.length > 0) && (
        <div className={s.rows}>
          {plain.map((r, i) => {
            const at = `${base}.${i}`;
            const rowIssues = issuesAt(issues, at);
            const nameErr = r.key ? envNameError(r.key) : null;
            return (
              <div key={`p${i}`} className={`${s.row} ${s.envRow}`} data-field={at}>
                <Input value={r.key} mono aria-label="Variable name" placeholder="NAME" onChange={(e) => setPlain(i, { key: e.target.value.replace(/\s/g, "") })} aria-invalid={!!nameErr || dupKey(r.key, i) || undefined} />
                <span className={s.envValue}>
                  <Input value={r.value} mono aria-label={`Value of ${r.key || "the variable"}`} placeholder="value" onChange={(e) => setPlain(i, { value: e.target.value })} title={r.interpolated ? "Uses compose variables" : undefined} />
                </span>
                <IconButton label={looksSecret(r.key) ? `Make ${r.key} a secret (recommended)` : `Make ${r.key || "it"} a secret`} onClick={() => makeSecret(i)} disabled={!r.key || !!nameErr}>
                  <LockSlash />
                </IconButton>
                <IconButton label="Remove this variable" onClick={() => setRowsRaw(rows.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
                {(nameErr || rowIssues.length > 0 || r.interpolated || (looksSecret(r.key) && r.value && !r.interpolated)) && (
                  <div className={s.rowNote}>
                    {nameErr && (
                      <p className={s.note} data-level="error">
                        {nameErr}
                      </p>
                    )}
                    {r.interpolated && <p className={s.note}>Compose fills in the variables in this value.</p>}
                    {looksSecret(r.key) && r.value && !r.interpolated && (
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
                            draft.setSecret(f.name, k, replacing[k]!);
                            const { [k]: _, ...rest } = replacing;
                            setReplacing(rest);
                          }
                          if (e.key === "Escape") {
                            const { [k]: _, ...rest } = replacing;
                            setReplacing(rest);
                          }
                        }}
                      />
                      <Button
                        onClick={() => {
                          draft.setSecret(f.name, k, replacing[k]!);
                          const { [k]: _, ...rest } = replacing;
                          setReplacing(rest);
                        }}
                      >
                        Save
                      </Button>
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
      <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setPending([...pending, { key: "", value: "", interpolated: false, secret: false, saved: false }])}>
        Add a variable
      </Button>
    </section>
  );
}

/** A new variable: typed here, added once it has a valid name (and as a secret when locked). */
function PendingEnv({ row, taken, onChange, onCommit, onRemove }: { row: EnvUiRow; taken: (k: string) => boolean; onChange: (r: EnvUiRow) => void; onCommit: () => void; onRemove: () => void }) {
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
      <IconButton label={row.secret ? "Keep it in the compose file" : "Make it a secret"} onClick={() => onChange({ ...row, secret: !row.secret })} className={row.secret ? s.toggleOn : undefined}>
        {row.secret ? <Lock /> : <LockSlash />}
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

// ---------------------------------------------------------------- advanced

const RESTART = [
  { value: "unless-stopped", label: "Unless stopped", description: "Comes back after crashes and reboots" },
  { value: "always", label: "Always" },
  { value: "on-failure", label: "On failure", description: "Only when it crashes" },
  { value: "no", label: "Never" },
];

function AdvancedGroup({ draft, form: f, names, issues, allIssues }: { draft: Draft; form: ServiceForm; names: string[]; issues: Issue[]; allIssues: Issue[] }) {
  const edit = draft.editCompose;
  const base = `services.${f.name}`;
  const [health, setHealthLocal] = React.useState<HealthForm>(f.health ?? { test: "", interval: "", timeout: "", retries: "", startPeriod: "" });
  React.useEffect(() => {
    setHealthLocal(f.health ?? { test: "", interval: "", timeout: "", retries: "", startPeriod: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(f.health)]);
  const [devices, setDevicesLocal] = useRows<string>(f.devices, (d) => DEVICE_RE.test(d), (d) => d, (done) => edit((doc) => setDevices(doc, f.name, done)));
  const others = names.filter((n) => n !== f.name);
  const count = [f.command, f.user, f.memory, f.devices.length ? "d" : "", f.hostNetwork ? "h" : "", f.health ? "hc" : "", f.dependsOn.length ? "dep" : "", f.privileged ? "p" : ""].filter(Boolean).length;
  const advIssues = issuesAt(allIssues, `${base}.advanced`).concat(issuesAt(issues, `${base}.memory`), issuesAt(issues, `${base}.dependsOn`), issuesAt(issues, `${base}.devices`, true));
  const [open, setOpen] = React.useState(advIssues.some((i) => i.level === "error"));
  const memErr = f.memory ? memoryError(f.memory) : null;

  return (
    <section className={s.group} data-field={`${base}.advanced`}>
      <Disclosure summary="More settings" meta={count ? `${count} set` : undefined} open={open} onOpenChange={setOpen}>
        <div className={s.stack} style={{ paddingTop: 8 }}>
          <div className={s.twoCol}>
            <Field label="Restart">
              <Select className={s.fill} value={f.restart || "no"} onChange={(v) => edit((doc) => setRestart(doc, f.name, v))} options={RESTART} />
            </Field>
            <Field label="Memory limit" optional description="Like 512m or 2g." error={memErr}>
              <Input value={f.memory} mono onChange={(e) => edit((doc) => setMemory(doc, f.name, e.target.value))} placeholder="No limit" />
            </Field>
            <div className={s.wide}>
              <Field label="Command" optional description="Replaces the image's own command. Quote arguments with spaces.">
                <Input value={f.command} mono onChange={(e) => edit((doc) => setCommand(doc, f.name, e.target.value))} placeholder="The image's default" spellCheck={false} />
              </Field>
            </div>
            <Field label="Run as user" optional description="uid:gid, like 1000:1000.">
              <Input value={f.user} mono onChange={(e) => edit((doc) => setUser(doc, f.name, e.target.value))} placeholder="The image's default" />
            </Field>
            <div>
              <Field label="Starts after" optional>
                {others.length ? (
                  <div className={s.checkList}>
                    {others.map((n) => (
                      <Checkbox key={n} checked={f.dependsOn.includes(n)} onChange={(on) => edit((doc) => setDependsOn(doc, f.name, on ? [...f.dependsOn, n] : f.dependsOn.filter((d) => d !== n)))}>
                        <span className="mono">{n}</span>
                      </Checkbox>
                    ))}
                  </div>
                ) : (
                  <p className={s.hint}>It&apos;s the only service.</p>
                )}
              </Field>
            </div>
          </div>
          <div className={s.inlineControl}>
            <span id={`hn-${f.name}`}>
              Use the server&apos;s network
              <span className={s.hint} style={{ display: "block" }}>
                For apps that discover devices on your network (DLNA, HomeKit). Its ports open straight on the server.
              </span>
            </span>
            <Switch checked={f.hostNetwork} onChange={(on) => edit((doc) => setHostNetwork(doc, f.name, on))} aria-labelledby={`hn-${f.name}`} />
          </div>
          <div className={s.inlineControl}>
            <span id={`pv-${f.name}`}>
              Privileged
              <span className={s.hint} style={{ display: "block" }}>
                Full access to this server&apos;s hardware and kernel. Only for apps that truly need it.
              </span>
            </span>
            <Switch checked={f.privileged} onChange={(on) => edit((doc) => setPrivileged(doc, f.name, on))} aria-labelledby={`pv-${f.name}`} />
          </div>
          <div className={s.stack} style={{ gap: 8 }}>
            <span className={s.groupTitle} style={{ fontSize: "var(--text-sm)" }}>
              Devices
            </span>
            {devices.map((d, i) => (
              <div key={i} className={`${s.row} ${s.devRow}`}>
                <Input value={d} mono aria-label="Device" placeholder="/dev/dri" onChange={(e) => setDevicesLocal(devices.map((x, j) => (j === i ? e.target.value : x)))} aria-invalid={(!!d && !DEVICE_RE.test(d)) || undefined} />
                <IconButton label="Remove this device" onClick={() => setDevicesLocal(devices.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setDevicesLocal([...devices, ""])}>
              Add a device
            </Button>
          </div>
          <div className={s.stack} style={{ gap: 8 }}>
            <span className={s.groupTitle} style={{ fontSize: "var(--text-sm)" }}>
              Health check
            </span>
            {f.healthDisabled ? (
              <p className={s.hint}>
                Turned off for this service.{" "}
                <button type="button" className={s.link} onClick={() => edit((doc) => setHealth(doc, f.name, null))}>
                  Use the image&apos;s own
                </button>
              </p>
            ) : (
              <div className={s.twoCol}>
                <div className={s.wide}>
                  <Field label="Command" optional description="Runs in the container; exit 0 means healthy. Empty uses the image's own check.">
                    <Input
                      value={health.test}
                      mono
                      placeholder="curl -fs http://localhost:8080/health || exit 1"
                      onChange={(e) => setHealthLocal({ ...health, test: e.target.value })}
                      onBlur={() => edit((doc) => setHealth(doc, f.name, health))}
                    />
                  </Field>
                </div>
                {health.test.trim() && (
                  <>
                    <Field label="Every" optional>
                      <Input value={health.interval} mono placeholder="30s" onChange={(e) => setHealthLocal({ ...health, interval: e.target.value })} onBlur={() => edit((doc) => setHealth(doc, f.name, health))} />
                    </Field>
                    <Field label="Tries before unhealthy" optional>
                      <Input value={health.retries} inputMode="numeric" mono placeholder="3" onChange={(e) => setHealthLocal({ ...health, retries: e.target.value.replace(/\D/g, "") })} onBlur={() => edit((doc) => setHealth(doc, f.name, health))} />
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>
          {f.extraKeys.length > 0 && (
            <p className={s.extra}>
              Also set in Compose: <span className="mono">{f.extraKeys.join(", ")}</span>.
            </p>
          )}
          <FieldNotes issues={advIssues} errors />
        </div>
      </Disclosure>
    </section>
  );
}

// ---------------------------------------------------------------- naming

function NameDialog({ open, onOpenChange, title, confirm, taken, initial, description, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; confirm: string; taken: string[]; initial: string; description?: string; onDone: (name: string) => void | Promise<void> }) {
  const [name, setName] = React.useState(initial);
  React.useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const err = name ? serviceNameError(name) ?? (taken.includes(name) ? "Another service already has that name." : null) : null;
  const submit = async () => {
    if (!name || err) return;
    await onDone(name);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name || !!err} onClick={() => void submit()}>
            {confirm}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Service name" description="Lowercase letters, digits, - and _." error={err}>
          <Input value={name} mono autoFocus onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={40} spellCheck={false} autoCapitalize="off" />
        </Field>
      </form>
    </Dialog>
  );
}
