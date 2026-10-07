"use client";
import { Plus, Xmark, ArrowRight } from "iconoir-react";
import type { BuilderTarget, Issue } from "@/lib/builder-types";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { parsePortString, portString, setPorts, type PortRow, type ServiceForm } from "@/lib/builder/compose";
import { FieldNotes, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { useRows, writtenIndex } from "./useRows";
import s from "../builder.module.css";

const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "").slice(0, 5)) || null);
const complete = (r: PortRow) => r.raw !== null || (!!r.container && r.container > 0 && r.container < 65536 && (r.host === null || (r.host > 0 && r.host < 65536)));

/** Ports other devices connect to directly. The web page has its own setting and needs no row. */
export function PortsGroup({ draft, form: f, issues, isWeb, target, usedPorts, onFix }: { draft: Draft; form: ServiceForm; issues: Issue[]; isWeb: boolean; target: BuilderTarget; usedPorts?: Map<number, string>; onFix: (id: string) => void }) {
  const base = `services.${f.name}.ports`;
  const [rows, setRows] = useRows<PortRow>(f.ports, complete, (r) => (r.raw !== null ? r : parsePortString(portString(r))), (done) => draft.editCompose((doc) => setPorts(doc, f.name, done)));
  const written = writtenIndex(rows, complete);
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
          {target === "umbrel" ? " through Umbrel's proxy" : ""}, so it doesn&apos;t need a row here. Add ports other devices connect to directly.
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
            // Checks number the rows in the file; a half-typed row isn't there yet.
            const w = written[i];
            const at = w === null ? `${base}.typing-${i}` : `${base}.${w}`;
            const rowIssues = w === null ? [] : issuesAt(issues, at);
            if (r.raw !== null) {
              return (
                <div key={i} className={s.stackTight} data-field={at}>
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
            const taken = r.host ? usedPorts?.get(r.host) : undefined;
            return (
              <div key={i} className={`${s.row} ${s.portRow}`} data-field={at}>
                <Input value={r.host ?? ""} inputMode="numeric" mono aria-label="Port on the server" placeholder="auto" onChange={(e) => set(i, { host: num(e.target.value) })} aria-invalid={!!err || undefined} />
                <span className={s.arrow} aria-hidden>
                  <ArrowRight />
                </span>
                <Input value={r.container ?? ""} inputMode="numeric" mono aria-label="Port in the app" placeholder="80" onChange={(e) => set(i, { container: num(e.target.value) })} aria-invalid={!r.container || undefined} />
                <span className={s.proto}>
                  <Select className={s.fill} value={r.proto} onChange={(proto) => set(i, { proto })} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} aria-label="Protocol" />
                </span>
                <IconButton label="Remove this port" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Xmark />
                </IconButton>
                {(rowIssues.length > 0 || (taken && !err)) && (
                  <div className={s.rowNote}>
                    {taken && !err && <p className={s.note} data-level="warning">{`Port ${r.host} is used by ${taken}.`}</p>}
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
