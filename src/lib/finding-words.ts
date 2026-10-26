/** Just enough of a finding to name what's wrong with an app. */
interface FindingLike {
  kind: string;
  severity: string;
}

/**
 * One word for an app with an open finding, shared by Home, Status and Apps so the same problem
 * reads the same everywhere (Docker can say "running" while the app's page doesn't answer).
 */
export function findingWord(f: FindingLike): string {
  if (f.kind === "monitor.down" || f.kind.endsWith(".unreachable")) return "Not answering";
  return f.severity === "fault" ? "Not working" : "Needs you";
}

/** The most serious open finding per app id. */
export function findingsByApp<F extends FindingLike & { subject: string | null }>(findings: readonly F[] | undefined): Map<string, F> {
  const m = new Map<string, F>();
  for (const f of findings ?? []) {
    if (!f.subject) continue;
    const had = m.get(f.subject);
    if (!had || (f.severity === "fault" && had.severity !== "fault")) m.set(f.subject, f);
  }
  return m;
}
