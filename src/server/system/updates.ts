import "server-only";
import type { UpdatesStatus } from "@/lib/system-types";
import { aptLockHolders, dpkgInterrupted, listsUpdatedAt, pendingClock, pendingUpdates, rebootStatus, refreshHistory } from "./apt";
import { activeRun } from "./apt-runner";

/** Everything the Updates tab shows, in one response. */
export async function updatesStatus(opts: { fresh?: boolean } = {}): Promise<UpdatesStatus> {
  const pending = await pendingUpdates({ fresh: opts.fresh });
  const history = refreshHistory();
  const clock = pendingClock();
  const run = activeRun();
  const list = pending.list;
  return {
    packages: list,
    counts: {
      total: list.length,
      security: list.filter((p) => p.security).length,
      needsReboot: list.filter((p) => p.needsReboot).length,
      newPackages: list.filter((p) => p.isNew).length,
      removals: pending.removals.length,
      heldBack: list.filter((p) => p.heldBack).length,
    },
    removals: pending.removals,
    lastRefresh: {
      at: history.at,
      ok: history.ok,
      error: history.error,
      lastSuccessAt: history.lastSuccessAt,
    },
    listsUpdatedAt: listsUpdatedAt(),
    busy: run ? [] : aptLockHolders(),
    activeRun: run,
    dpkgInterrupted: !run && dpkgInterrupted(),
    reboot: rebootStatus(),
    oldestPendingAt: list.length ? clock.oldestPendingAt : null,
    oldestSecurityAt: list.some((p) => p.security) ? clock.oldestSecurityAt : null,
    checkedAt: pending.at,
  };
}
