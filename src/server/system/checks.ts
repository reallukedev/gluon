import "server-only";
import { registerCheck, registerRemedy } from "../alerts/engine";
import { raise, resolve, resolveMissing, type Remedy } from "../findings";
import { uptimeSeconds } from "../host/proc";
import { AppError } from "../errors";
import { formatRelative, plural } from "@/lib/format";
import { dpkgInterrupted, pendingClock, pendingUpdates, rebootStatus, refreshHistory } from "./apt";
import { activeRun, startRun } from "./apt-runner";
import { failedServices, failureReason, serviceAction } from "./services";
import { setNtp, timeStatus } from "./time";
import { parseUnit, policyFor } from "./units";
import { failuresSince, keyLabelFor, liveLogins, refreshSignIns, reverseLookup, signInsSince, zoneOf } from "./logins";

const DAY = 86_400_000;
const DOCKER_PKGS = /^(docker-ce|docker\.io|containerd|containerd\.io|moby-engine)$/;

// ---------------------------------------------------------------- updates waiting

registerCheck("system-updates", 30 * 60_000, async () => {
  if (activeRun()) return; // being installed right now; re-evaluated when the run finishes
  const { list } = await pendingUpdates();
  const installable = list.filter((p) => !p.heldBack);
  if (!installable.length) return resolve("system.updates");

  const security = installable.filter((p) => p.security);
  const clock = pendingClock();
  const t = Date.now();
  const secDays = security.length && clock.oldestSecurityAt ? (t - clock.oldestSecurityAt) / DAY : 0;
  const allDays = clock.oldestPendingAt ? (t - clock.oldestPendingAt) / DAY : 0;
  const overdueSecurity = secDays > 3;
  const overdue = allDays > 30;
  const n = installable.length;

  let title: string;
  let cause: string;
  if (overdueSecurity) {
    title = `${plural(security.length, "security update")} ${security.length === 1 ? "has" : "have"} been waiting ${Math.floor(secDays)} days`;
    cause = "They fix known security problems. Installing takes a few minutes and apps keep running.";
  } else if (overdue) {
    title = "Updates have been waiting for over a month";
    cause = `${plural(n, "update")} ${n === 1 ? "is" : "are"} ready. Installing takes a few minutes and apps keep running.`;
  } else {
    title = `${plural(n, "update")} ready to install${security.length ? ` (${security.length} security)` : ""}`;
    cause = "Installing takes a few minutes and apps keep running.";
  }

  const consequences = [`Downloads and installs ${plural(n, "package")}. Apps keep running.`];
  if (installable.some((p) => DOCKER_PKGS.test(p.name))) consequences.push("Docker is being updated, so every app (and Gluon) restarts for a minute or two.");
  if (installable.some((p) => p.needsReboot)) consequences.push("Some of these (the kernel or system core) only take effect after restarting the server. Gluon will tell you when.");
  consequences.push("You can follow the progress in System → Updates.");

  const remedy: Remedy = dpkgInterrupted()
    ? { action: "", label: "Repair updates", href: "/system?tab=updates" }
    : {
        action: "system.installUpdates",
        label: `Install ${plural(n, "update")}`,
        confirm: { title: `Install ${plural(n, "update")} now?`, consequences },
      };

  raise({
    id: "system.updates",
    kind: "system.updates",
    severity: overdueSecurity || overdue ? "attention" : "info",
    subject: "updates",
    title,
    cause,
    detail: {
      total: n,
      security: security.length,
      oldestPendingAt: clock.oldestPendingAt,
      oldestSecurityAt: clock.oldestSecurityAt,
    },
    remedy,
  });
});

registerRemedy("system.installUpdates", {
  recent: true,
  async run({ user }) {
    const r = await startRun(user, { kind: "upgrade", packages: null }, {});
    return {
      message: `Installing updates (${r.id}). Follow along in System → Updates.`,
    };
  },
});

// ---------------------------------------------------------------- reboot required

registerCheck("system-reboot", 10 * 60_000, () => {
  const r = rebootStatus();
  if (!r.required) return resolve("system.reboot");
  raise({
    id: "system.reboot",
    kind: "system.reboot",
    severity: "attention",
    subject: "server",
    title: "The server needs a restart to finish updating",
    cause: `${r.reasons.join(" ")} Apps are unavailable for a few minutes while it restarts.`,
    detail: {
      runningKernel: r.runningKernel,
      newestKernel: r.newestKernel,
      packages: r.packages,
    },
    remedy: {
      action: "",
      label: "Restart the server",
      href: "/system?tab=power",
    },
  });
});

// ---------------------------------------------------------------- failed services

registerCheck("system-failed-units", 60_000, async () => {
  const failed = await failedServices();
  const open = new Set<string>();
  for (const s of failed) {
    const id = `system.unit-failed:${s.unit}`;
    open.add(id);
    const pol = policyFor(s.unit);
    const canRemedy = !pol.blocked.includes("restart") && !pol.needsConfirm.includes("restart") && !pol.needsRecentAuth.includes("restart");
    const when = s.inactiveSince ? ` ${formatRelative(s.inactiveSince)}` : "";
    raise({
      id,
      kind: "system.unit-failed",
      severity: s.important ? "fault" : "attention",
      subject: s.unit,
      title: `${s.name} stopped working`,
      cause: `It stopped${when} because ${failureReason(s)}. Its log usually says why.`,
      detail: {
        unit: s.unit,
        result: s.result,
        exitStatus: s.exitStatus,
        important: s.important,
      },
      remedy: canRemedy
        ? {
            action: "system.restartUnit",
            label: `Restart ${s.name}`,
            params: { unit: s.unit },
          }
        : {
            action: "",
            label: "Open the service",
            href: `/system?tab=services&unit=${encodeURIComponent(s.unit)}`,
          },
    });
  }
  resolveMissing("system.unit-failed", open);
});

registerRemedy("system.restartUnit", {
  async run({ params }) {
    const unit = parseUnit(params.unit);
    const pol = policyFor(unit);
    if (pol.blocked.includes("restart") || pol.needsConfirm.includes("restart") || pol.needsRecentAuth.includes("restart")) {
      throw new AppError("use_services", "Restart that one from System → Services, where Gluon can confirm it with you first.", 409);
    }
    const r = await serviceAction(unit, "restart");
    return { message: r.message };
  },
});

// ---------------------------------------------------------------- can't check for updates

registerCheck("system-apt-refresh", 60 * 60_000, () => {
  const h = refreshHistory();
  const t = Date.now();
  const failingFor = h.lastFailureSince ? t - h.lastFailureSince : 0;
  const staleFor = h.lastSuccessAt ? t - h.lastSuccessAt : failingFor;
  if (h.ok !== false || failingFor < 2 * DAY || staleFor < 3 * DAY) return resolve("system.apt-refresh");
  raise({
    id: "system.apt-refresh",
    kind: "system.apt-refresh",
    severity: "attention",
    subject: "updates",
    title: "The server can't check for updates",
    cause: `It has been failing since ${formatRelative(h.lastFailureSince)}${h.lastSuccessAt ? ` (last worked ${formatRelative(h.lastSuccessAt)})` : ""}. ${h.error ?? ""}`.trim(),
    detail: {
      lastSuccessAt: h.lastSuccessAt,
      failingSince: h.lastFailureSince,
      error: h.error,
    },
    remedy: { action: "", label: "See updates", href: "/system?tab=updates" },
  });
});

// ---------------------------------------------------------------- clock

type G = typeof globalThis & { __gluonClockUnsynced?: number | null };
const g = globalThis as G;

registerCheck("system-clock", 5 * 60_000, async () => {
  const t = await timeStatus();
  if (t.ntp === false && t.canNtp !== false) {
    g.__gluonClockUnsynced = null;
    raise({
      id: "system.clock",
      kind: "system.clock",
      severity: "attention",
      subject: "clock",
      title: "Automatic time is turned off",
      cause: "The clock drifts without it, which can break certificates, sign-ins and scheduled tasks.",
      remedy: { action: "system.enableNtp", label: "Turn on automatic time" },
    });
    return;
  }
  if (t.ntp && t.synced === false && uptimeSeconds() > 30 * 60) {
    g.__gluonClockUnsynced ??= Date.now();
    if (Date.now() - g.__gluonClockUnsynced < 20 * 60_000) return;
    raise({
      id: "system.clock",
      kind: "system.clock",
      severity: "attention",
      subject: "clock",
      title: "The clock isn't syncing with a time server",
      cause: `Automatic time is on, but the server hasn't reached ${t.server ?? "a time server"}. Certificates, sign-ins and scheduled tasks rely on the right time. Check the internet connection.`,
      remedy: {
        action: "",
        label: "Check time settings",
        href: "/system#time",
      },
    });
    return;
  }
  g.__gluonClockUnsynced = null;
  resolve("system.clock");
});

registerRemedy("system.enableNtp", {
  async run() {
    await setNtp(true);
    return { message: "Turned on automatic time" };
  },
});

// ---------------------------------------------------------------- SSH sign-ins from outside

const SIGNINS_HREF = "/system?tab=sign-ins";

/**
 * "Needs you" when someone signs in over SSH from outside the home networks. One finding per
 * person and address, open for a day after the latest such sign-in (or while it's still connected),
 * so dismissing it acknowledges that source and a new address raises a new one.
 */
registerCheck("system-ssh-away", 60_000, async () => {
  await refreshSignIns(30_000);
  const recent = signInsSince(Date.now() - DAY).filter((s) => s.ip && zoneOf(s.ip) === "away");
  const open = new Set<string>();
  const groups = new Map<string, typeof recent>();
  for (const s of recent) {
    const k = `${s.user}@${s.ip}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  for (const [k, list] of groups) {
    const id = `system.ssh-away:${k}`;
    open.add(id);
    const last = list.reduce((a, b) => (b.start > a.start ? b : a));
    const still = list.some((s) => s.open);
    const name = await reverseLookup(last.ip).catch(() => null);
    const how =
      last.method === "key"
        ? keyLabelFor(last.user, last.fingerprint)
          ? `with the key “${keyLabelFor(last.user, last.fingerprint)}”`
          : "with a key"
        : last.method === "password" || last.method === "keyboard"
          ? "with a password"
          : "";
    raise({
      id,
      kind: "system.ssh-away",
      severity: "attention",
      subject: last.user,
      title: `${last.user} signed in over SSH from outside your home network`,
      cause: `From ${last.ip}${name ? ` (${name})` : ""} ${formatRelative(last.start)}${how ? ` ${how}` : ""}${list.length > 1 ? `, ${plural(list.length, "time")} today` : ""}. ${still ? "They're still connected. " : ""}If that wasn't you or someone you trust, end the session and change that account's password.`,
      detail: {
        user: last.user,
        ip: last.ip,
        host: name,
        at: last.start,
        count: list.length,
        connected: still,
      },
      remedy: {
        action: "",
        label: still ? "See who's connected" : "See sign-ins",
        href: SIGNINS_HREF,
      },
    });
  }
  resolveMissing("system.ssh-away", open);
});

/** A warning when failed SSH sign-ins from outside spike: someone is guessing passwords. */
registerCheck("system-ssh-failures", 5 * 60_000, async () => {
  await refreshSignIns(30_000);
  const fails = failuresSince(Date.now() - 3_600_000).filter((f) => zoneOf(f.ip) === "away");
  if (fails.length <= 50) return resolve("system.ssh-failures");
  const bySource = new Map<string, number>();
  for (const f of fails) bySource.set(f.ip, (bySource.get(f.ip) ?? 0) + 1);
  const top = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  const live = await liveLogins({ maxAgeMs: 60_000 }).catch(() => null);
  const pw = live?.posture.password;
  raise({
    id: "system.ssh-failures",
    kind: "system.ssh-failures",
    severity: "attention",
    subject: "ssh",
    title: "Someone outside is trying to guess SSH passwords",
    cause: `${plural(fails.length, "failed sign-in")} in the last hour from ${plural(top.length, "address", "addresses")} outside your home, most from ${top[0]![0]}. ${
      pw
        ? "Password sign-in is allowed, so a weak password could let them in. Turning passwords off and using keys stops this."
        : "Only keys are accepted, so guessing passwords can't work; this is noise, but it shows the SSH port is open to the internet."
    }`,
    detail: {
      count: fails.length,
      sources: top.slice(0, 5).map(([ip, n]) => ({ ip, n })),
      passwordLogin: pw ?? null,
    },
    remedy: { action: "", label: "See sign-in attempts", href: SIGNINS_HREF },
  });
});
