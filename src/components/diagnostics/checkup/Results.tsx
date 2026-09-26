"use client";
import * as React from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import type { CheckPlanItem, CheckResult, CheckupGroup } from "@/lib/diagnostics-types";
import { RemedyButton } from "@/components/status/NeedsYou";
import { Mark } from "./Instruments";
import s from "./checkup.module.css";

export const resultDomId = (id: string) => `check-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

function Evidence({ text }: { text: string }) {
  return (
    <Disclosure summary="The numbers" className={s.evidence}>
      <pre className={s.evidenceBody}>{text}</pre>
    </Disclosure>
  );
}

function Fix({ r, onApplied }: { r: CheckResult; onApplied: (id: string) => void }) {
  if (!r.fix) return null;
  return <RemedyButton remedy={{ action: r.fix.action, label: r.fix.label, params: r.fix.params, confirm: r.fix.confirm, href: r.fix.href }} findingId={r.fix.findingId ?? null} onDone={() => onApplied(r.id)} />;
}

export function ResultRow({ r, item, groupLabel, compact, applied, onApplied }: { r: CheckResult; item?: CheckPlanItem; groupLabel?: string; compact?: boolean; applied: boolean; onApplied: (id: string) => void }) {
  return (
    <li className={s.result} id={resultDomId(r.id)} data-state={r.state}>
      <Mark state={r.state} />
      <div className={s.resultText}>
        <p className={s.resultTitle}>{r.title}</p>
        {!compact && r.detail && <p className={s.resultDetail}>{r.detail}</p>}
        <div className={s.resultMeta}>
          {groupLabel && <span>{groupLabel}</span>}
          {item && item.label !== groupLabel && !compact && <span>{item.label}</span>}
          {compact && r.detail && <span>{r.detail}</span>}
          {!compact && r.value && <span className="num">{r.value}</span>}
          {applied && <span className={s.applied}>Fix applied. Run the checkup again to confirm.</span>}
        </div>
        {r.evidence && <Evidence text={r.evidence} />}
      </div>
      {compact ? (
        r.value ? <span className={s.passedValue}>{r.value}</span> : <span />
      ) : (
        <div className={s.resultActions}>
          <Fix r={r} onApplied={onApplied} />
        </div>
      )}
    </li>
  );
}

const ORDER = { fail: 0, warn: 1, ok: 2, skip: 3 } as const;

/**
 * Problems first (broken, then worth a look) with their fixes; the checks that passed fold away under
 * one line so the list stays about what needs attention.
 */
export function ResultList({ plan, groups, results, showGroups, openPassed, setOpenPassed, emptyNote }: { plan: CheckPlanItem[]; groups: CheckupGroup[]; results: CheckResult[]; showGroups: boolean; openPassed: boolean; setOpenPassed: (v: boolean) => void; emptyNote?: React.ReactNode }) {
  const [applied, setApplied] = React.useState<Set<string>>(() => new Set());
  const onApplied = React.useCallback((id: string) => setApplied((a) => new Set(a).add(id)), []);
  const planIdx = React.useMemo(() => new Map(plan.map((p, i) => [p.id, i])), [plan]);
  const byId = React.useMemo(() => new Map(plan.map((p) => [p.id, p])), [plan]);
  const groupLabel = (id: string) => (showGroups ? groups.find((g) => g.id === byId.get(id)?.group)?.label : undefined);
  const sorted = [...results].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (planIdx.get(a.id) ?? 0) - (planIdx.get(b.id) ?? 0));
  const problems = sorted.filter((r) => r.state === "fail" || r.state === "warn");
  const rest = sorted.filter((r) => r.state === "ok" || r.state === "skip");
  const passed = rest.filter((r) => r.state === "ok").length;
  const skipped = rest.length - passed;

  return (
    <>
      {problems.length ? (
        <ul className={s.results} role="list" aria-label="Problems">
          {problems.map((r) => (
            <ResultRow key={r.id} r={r} item={byId.get(r.id)} groupLabel={groupLabel(r.id)} applied={applied.has(r.id)} onApplied={onApplied} />
          ))}
        </ul>
      ) : (
        emptyNote
      )}
      {rest.length > 0 && (
        <Disclosure
          variant="panel"
          open={openPassed}
          onOpenChange={setOpenPassed}
          summary={`${passed ? `The ${passed} check${passed === 1 ? "" : "s"} that passed` : ""}${passed && skipped ? " and " : ""}${skipped ? `${passed ? "" : "The "}${skipped} skipped` : ""}`}
        >
          <ul className={`${s.results} ${s.passed}`} role="list" aria-label="Checks that passed">
            {rest.map((r) => (
              <ResultRow key={r.id} r={r} item={byId.get(r.id)} groupLabel={groupLabel(r.id)} compact applied={false} onApplied={onApplied} />
            ))}
          </ul>
        </Disclosure>
      )}
    </>
  );
}
