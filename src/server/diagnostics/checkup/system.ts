import "server-only";
import { failedServices, failureReason } from "../../system/services";
import { timeStatus } from "../../system/time";
import { rebootStatus, pendingUpdates, pendingClock } from "../../system/apt";
import { dockerUsage } from "../../storage/cleanup";
import { formatBytes, formatRelative, plural } from "@/lib/format";
import { fail, go, kv, ok, skip, warn, type CheckSpec, type Outcome } from "./core";

/** System: failed services, clock, restart needed, security updates, Docker's disk use. */

export async function unitsOutcome(): Promise<Outcome> {
  const failed = await failedServices();
  if (!failed.length) return ok("No system services have failed");
  const evidence = kv(failed.map((s) => [s.unit, `${s.result ?? "failed"}${s.exitStatus !== null ? ` (exit ${s.exitStatus})` : ""}${s.inactiveSince ? `, ${formatRelative(s.inactiveSince)}` : ""}`]));
  const first = failed.find((s) => s.important) ?? failed[0]!;
  const findings = failed.map((s) => `system.unit-failed:${s.unit}`);
  const title = failed.length === 1 ? `${first.name} stopped working` : `${failed.length} system services have failed`;
  return (first.important ? fail : warn)(title, {
    detail: failed.length === 1 ? `It stopped because ${failureReason(first)}. Its log usually says why.` : `Including ${first.name}, which stopped because ${failureReason(first)}.`,
    evidence,
    findings,
    fix: go(failed.length === 1 ? "Open the service" : "See services", `/system?tab=services&unit=${encodeURIComponent(first.unit)}`),
  });
}

export async function clockOutcome(): Promise<Outcome> {
  const t = await timeStatus();
  const evidence = kv([
    ["Automatic time", t.ntp === null ? "unknown" : t.ntp ? "on" : "off"],
    ["Synchronised", t.synced === null ? "unknown" : t.synced ? "yes" : "no"],
    ["Time server", t.server],
    ["Time zone", t.timezone],
    ["Server clock", new Date(t.now).toISOString()],
    ["Gluon's clock", new Date().toISOString()],
  ]);
  if (t.ntp === false && t.canNtp !== false) return warn("Automatic time is turned off", { detail: "The clock drifts without it, which can break certificates, sign-ins and scheduled tasks.", evidence, findings: ["system.clock"], fix: { label: "Turn on automatic time", action: "system.enableNtp" } });
  if (t.ntp && t.synced === false) return warn("The clock isn't syncing with a time server", { detail: `Automatic time is on, but the server hasn't reached ${t.server ?? "a time server"}. Check the internet connection.`, evidence, findings: ["system.clock"], fix: go("Check time settings", "/system?tab=overview") });
  if (t.synced === null) return skip("Gluon couldn't tell whether the clock is in sync", { evidence });
  return ok(`The clock is in sync${t.server ? ` with ${t.server}` : ""}`, { evidence });
}

export function rebootOutcome(): Outcome {
  const r = rebootStatus();
  const evidence = kv([
    ["Running kernel", r.runningKernel],
    ["Newest installed", r.newestKernel],
    ["Asked by", r.packages.join(", ") || null],
    ["Since", r.since ? new Date(r.since).toISOString() : null],
  ]);
  if (!r.required) return ok("No restart is needed to finish updates", { evidence });
  return warn("The server needs a restart to finish updating", { detail: `${r.reasons.join(" ")} Apps are unavailable for a few minutes while it restarts.`, evidence, findings: ["system.reboot"], fix: go("Restart the server", "/system?tab=power") });
}

export async function updatesOutcome(): Promise<Outcome> {
  const { list, at } = await pendingUpdates();
  const installable = list.filter((p) => !p.heldBack);
  const security = installable.filter((p) => p.security);
  const clock = pendingClock();
  const evidence = kv([
    ["Waiting", installable.length],
    ["Security", security.length ? `${security.length}: ${security.slice(0, 8).map((p) => p.name).join(", ")}${security.length > 8 ? "…" : ""}` : 0],
    ["Held back", list.length - installable.length],
    ["Oldest security update", clock.oldestSecurityAt ? formatRelative(clock.oldestSecurityAt) : null],
    ["Package lists read", formatRelative(at)],
  ]);
  const findings = ["system.updates"];
  const fix = go("See updates", "/system?tab=updates");
  if (security.length) {
    const days = clock.oldestSecurityAt ? Math.floor((Date.now() - clock.oldestSecurityAt) / 86_400_000) : 0;
    return warn(`${plural(security.length, "security update")} ${security.length === 1 ? "is" : "are"} waiting${days > 1 ? ` (for ${days} days)` : ""}`, { value: String(security.length), detail: "They fix known security problems. Installing takes a few minutes and apps keep running.", evidence, findings, fix });
  }
  if (installable.length) return ok(`No security updates waiting (${plural(installable.length, "other update")} ready)`, { value: String(installable.length), evidence });
  return ok("The system is up to date", { evidence });
}

export async function dockerDiskOutcome(): Promise<Outcome> {
  const u = await dockerUsage();
  if (!u) return skip("Gluon couldn't ask Docker how much space it uses");
  const total = u.images.bytes + u.containers.bytes + u.volumes.bytes + u.buildCache.bytes;
  const reclaim = u.images.reclaimable + u.containers.reclaimable + u.buildCache.reclaimable;
  const evidence = kv([
    ["Images", `${u.images.count} · ${formatBytes(u.images.bytes)} (${formatBytes(u.images.reclaimable)} unused)`],
    ["Containers", `${u.containers.count} · ${formatBytes(u.containers.bytes)} (${formatBytes(u.containers.reclaimable)} in stopped ones)`],
    ["Volumes", `${u.volumes.count} · ${formatBytes(u.volumes.bytes)} (${formatBytes(u.volumes.reclaimable)} unused)`],
    ["Build cache", `${u.buildCache.count} · ${formatBytes(u.buildCache.bytes)} (${formatBytes(u.buildCache.reclaimable)} unused)`],
  ]);
  const fix = go(`Review ${formatBytes(reclaim)} to free`, "/storage?tab=space");
  if (reclaim >= 10 * 1000 ** 3) return warn(`Docker could free ${formatBytes(reclaim)} of unused images and leftovers`, { value: formatBytes(reclaim), detail: `It uses ${formatBytes(total)} in all. Nothing that's running would be touched.`, evidence, fix });
  return ok(`Docker uses ${formatBytes(total)}${reclaim > 100 * 1000 ** 2 ? `; ${formatBytes(reclaim)} of it could be freed` : ""}`, { value: formatBytes(total), evidence });
}

export function systemChecks(): CheckSpec[] {
  const g = "system";
  return [
    { id: "system.units", group: g, label: "Services", run: unitsOutcome },
    { id: "system.clock", group: g, label: "Clock", run: clockOutcome },
    { id: "system.reboot", group: g, label: "Restart needed", run: async () => rebootOutcome() },
    { id: "system.updates", group: g, label: "Security updates", timeoutMs: 60_000, run: updatesOutcome },
    { id: "system.docker", group: g, label: "Docker disk use", run: dockerDiskOutcome },
  ];
}
