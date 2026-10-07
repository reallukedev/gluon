"use client";
import { Plus, Xmark } from "iconoir-react";
import type { Issue } from "@/lib/builder-types";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { setLabels, type LabelRow, type ServiceForm } from "@/lib/builder/compose";
import { labelKeyError } from "@/lib/builder/names";
import { FieldNotes, issuesAt } from "../Issues";
import type { Draft } from "../state";
import { useRows } from "./useRows";
import s from "../builder.module.css";

/** Docker labels, for tools that read them (Traefik, Watchtower, Homepage…). */
export function LabelsField({ draft, form: f, issues }: { draft: Draft; form: ServiceForm; issues: Issue[] }) {
  const base = `services.${f.name}.labels`;
  const [rows, setRows] = useRows<LabelRow>(f.labels, (r) => !labelKeyError(r.key), (r) => r, (done) => draft.editCompose((doc) => setLabels(doc, f.name, done)));
  const set = (i: number, patch: Partial<LabelRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className={s.subGroup} data-field={base}>
      <h4 className={s.subTitle}>Labels</h4>
      {rows.length === 0 && <p className={s.hint}>For tools that read them, like Traefik, Watchtower or Homepage.</p>}
      {rows.map((r, i) => {
        const err = r.key ? labelKeyError(r.key) : null;
        return (
          <div key={i} className={`${s.row} ${s.labelRow}`} data-field={`${base}.${i}`}>
            <Input value={r.key} mono aria-label="Label name" placeholder="com.example.role" onChange={(e) => set(i, { key: e.target.value.replace(/\s/g, "") })} aria-invalid={!!err || undefined} />
            <Input value={r.value} mono aria-label={`Value of ${r.key || "the label"}`} placeholder="value" onChange={(e) => set(i, { value: e.target.value })} />
            <IconButton label="Remove this label" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Xmark />
            </IconButton>
            {err && (
              <div className={s.rowNote}>
                <p className={s.note} data-level="error">
                  {err}
                </p>
              </div>
            )}
          </div>
        );
      })}
      <FieldNotes issues={issuesAt(issues, base, true).filter((i) => i.level !== "error")} />
      <Button size="sm" variant="ghost" icon={<Plus />} className={s.addRow} onClick={() => setRows([...rows, { key: "", value: "" }])}>
        Add a label
      </Button>
    </div>
  );
}
