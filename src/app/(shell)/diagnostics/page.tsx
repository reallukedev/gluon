import { requireAdmin } from "@/server/auth/session";
import { checkupState } from "@/server/diagnostics/checkup/state";
import { DiagnosticsView, type DiagTab } from "@/components/diagnostics/DiagnosticsView";
import type { CheckupKind } from "@/lib/diagnostics-types";

export const metadata = { title: "Diagnostics" };

const TABS: DiagTab[] = ["checkup", "traffic", "connections", "requests", "processes", "logs", "tools"];
const KINDS: CheckupKind[] = ["full", "app", "address", "internet", "server", "space", "drive", "safety"];
const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : null);

export default async function DiagnosticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const rawTab = str(sp.tab);
  // Older links: ?tab=kernel meant the kernel log.
  const tab: DiagTab = rawTab === "kernel" ? "logs" : TABS.includes(rawTab as DiagTab) ? (rawTab as DiagTab) : "checkup";
  const rawSource = rawTab === "kernel" ? "kernel" : str(sp.source);
  const source = rawSource === "journal" || rawSource === "docker" || rawSource === "kernel" ? rawSource : null;
  const unitRaw = str(sp.unit);
  const unit = unitRaw && /^[A-Za-z0-9@._:\\-]{1,128}$/.test(unitRaw) ? unitRaw : null;
  const runRaw = str(sp.run);
  const runId = runRaw && /^ck_[a-z0-9]{6,40}$/.test(runRaw) ? runRaw : null;
  const kind = str(sp.start) as CheckupKind | null;
  const start = kind && KINDS.includes(kind) ? { kind, target: str(sp.target) } : null;
  const checkup = tab === "checkup" ? await checkupState().catch(() => null) : null;
  return <DiagnosticsView tab={tab} logSource={source} logUnit={unit} checkup={checkup} runId={runId} start={start} />;
}
