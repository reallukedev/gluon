import { requireAdmin } from "@/server/auth/session";
import { parseTarget } from "@/lib/terminal/types";
import { listTargets } from "@/server/terminal/targets";
import { TerminalView } from "@/components/terminal/TerminalView";

export const metadata = { title: "Terminal" };

export default async function TerminalPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireAdmin();
  const sp = await searchParams;
  const target = typeof sp.target === "string" ? parseTarget(sp.target) : null;
  // A command in the link is only typed into the prompt, never run on its own.
  const run = typeof sp.run === "string" && sp.run.length <= 2000 ? sp.run : null;
  // The target picker names the server on first paint instead of widening once the list arrives.
  const targets = await listTargets().catch(() => undefined);
  return <TerminalView initialTarget={target} initialRun={run} initialMode={sp.mode === "terminal" ? "terminal" : "commands"} initialTargets={targets} userId={user.id} />;
}
