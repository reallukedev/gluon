"use client";
import * as React from "react";
import type { ServiceAction, ServiceInfo } from "@/lib/system-types";
import { api, ApiError } from "@/lib/client/api";
import { useConfirm, type ConfirmOptions } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import type { LineState } from "@/components/ui/StateLine";

/** Menu/button wording for each action. */
export const ACTION_LABEL: Record<ServiceAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  reload: "Reload settings",
  enable: "Start at boot",
  disable: "Don't start at boot",
};

const PROGRESS: Record<ServiceAction, string> = {
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  reload: "Reloading",
  enable: "Turning on at boot:",
  disable: "Turning off at boot:",
};

/** The state glyph and a short label for a service row. */
export function serviceLine(s: Pick<ServiceInfo, "active" | "sub" | "load" | "enabled">): { state: LineState; label: string } {
  if (s.load === "masked" || s.enabled === "masked") return { state: "paused", label: "Masked" };
  switch (s.active) {
    case "active":
      return s.sub === "exited" ? { state: "stopped", label: "Finished" } : s.sub === "reloading" ? { state: "starting", label: "Reloading" } : { state: "running", label: "Running" };
    case "activating":
      return s.sub === "auto-restart" ? { state: "starting", label: "Restarting after a crash" } : { state: "starting", label: "Starting" };
    case "deactivating":
      return { state: "starting", label: "Stopping" };
    case "reloading":
      return { state: "starting", label: "Reloading" };
    case "failed":
      return { state: "unhealthy", label: "Failed" };
    default:
      return { state: "stopped", label: "Stopped" };
  }
}

export function bootLabel(enabled: string | null): string {
  switch (enabled) {
    case "enabled":
    case "enabled-runtime":
    case "alias":
      return "At boot";
    case "disabled":
      return "Off";
    case "static":
    case "indirect":
    case "generated":
      return "When needed";
    case "masked":
    case "masked-runtime":
      return "Masked";
    case "transient":
      return "Temporary";
    default:
      return "—";
  }
}

/** Which actions to offer now, given state and Gluon's policy for the unit. */
export function availableActions(svc: ServiceInfo): ServiceAction[] {
  const out: ServiceAction[] = [];
  const running = svc.active === "active" || svc.active === "activating" || svc.active === "reloading";
  const masked = svc.load === "masked" || svc.enabled === "masked";
  if (!masked) {
    if (!running) out.push("start");
    if (running || svc.active === "failed") out.push("restart");
    if (running && svc.canReload) out.push("reload");
    if (running && svc.canStop) out.push("stop");
    if (svc.enabled === "disabled") out.push("enable");
  }
  if (svc.enabled === "enabled") out.push("disable");
  return out.filter((a) => !svc.blocked.includes(a));
}

function stopConsequence(svc: ServiceInfo): string {
  const u = svc.unit;
  if (/^(ssh|sshd)\.service$/.test(u)) return "Nobody can sign in over SSH until it's started again. If Gluon stops working too, you'd need a keyboard and screen on the server.";
  if (/^(smbd|nmbd)\.service$/.test(u)) return "Shared folders go offline on other computers.";
  if (/^(docker|containerd)\.service$/.test(u)) return "Every app stops, including Gluon, so this page stops working. Start Docker again over SSH, or restart the server.";
  if (/^casaos/.test(u)) return "The CasaOS dashboard stops working. Apps keep running.";
  if (/timesyncd|chrony|ntpsec/.test(u)) return "The clock stops syncing and may drift.";
  if (/^cron\.service$/.test(u)) return "Scheduled tasks stop running.";
  if (/^(networking|NetworkManager|systemd-networkd)\.service$/.test(u)) return "The server may drop off the network, taking this page with it. You'd need a keyboard and screen to fix it.";
  if (/resolved/.test(u)) return "The server may stop finding websites by name.";
  if (/fail2ban/.test(u)) return "Repeated failed logins stop being blocked.";
  return `${svc.name} stops until you start it again.`;
}

function askFor(svc: ServiceInfo, action: ServiceAction): Omit<ConfirmOptions, "onConfirm"> | null {
  const needsConfirm = svc.needsConfirm.includes(action);
  const takesGluonDown = /^(docker|containerd)\.service$/.test(svc.unit);
  if (action === "stop" && (svc.important || needsConfirm)) {
    const dangerous = takesGluonDown || /^(networking|NetworkManager|systemd-networkd|ssh|sshd)\.service$/.test(svc.unit);
    return {
      title: `Stop ${svc.name}?`,
      consequences: [stopConsequence(svc), svc.enabled === "enabled" ? "It starts again on its own the next time the server restarts." : "It stays stopped after a restart too."],
      confirmLabel: `Stop ${svc.name}`,
      holdMs: dangerous ? 1500 : undefined,
    };
  }
  if (action === "restart" && needsConfirm) {
    return {
      title: `Restart ${svc.name}?`,
      consequences: ["Every app restarts, including Gluon. Your apps blink off for a minute or two.", "This page reconnects on its own when Gluon is back."],
      confirmLabel: `Restart ${svc.name}`,
      variant: "primary",
    };
  }
  if (action === "disable" && (svc.important || needsConfirm)) {
    return {
      title: `Stop starting ${svc.name} at boot?`,
      consequences: [
        `After the next restart, ${svc.name} stays off until someone starts it.`,
        takesGluonDown ? "That includes every app and Gluon itself." : "Anything that relies on it won't work after a restart until it's started.",
        "It keeps running for now.",
      ],
      confirmLabel: "Don't start at boot",
    };
  }
  return null;
}

/**
 * Service actions with the right confirmation for each unit. The server enforces the same rules
 * (and asks for a fresh sign-in where needed); this only decides what to ask first.
 */
export function useServiceActions(onDone: () => void, onFailed?: (unit: string) => void) {
  const [confirm, confirmNode] = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (svc: ServiceInfo, action: ServiceAction, inDialog = false) => {
      setBusy(svc.unit);
      const t = toast.loading(`${PROGRESS[action]} ${svc.name}…`);
      try {
        const r = await api.post<{ message: string; queued: boolean }>(`/api/system/services/${encodeURIComponent(svc.unit)}`, {
          action,
          confirm: svc.needsConfirm.includes(action) || undefined,
        });
        toast.update(t, r.queued ? "info" : "success", { title: r.message });
        onDone();
      } catch (e) {
        if (e instanceof ApiError && e.code === "reauth_cancelled") {
          toast.dismiss(t);
          return;
        }
        // Inside a confirmation, the dialog shows the error itself.
        if (inDialog) toast.dismiss(t);
        else
          toast.update(t, "error", {
            title: e instanceof Error ? e.message : `Couldn't ${ACTION_LABEL[action].toLowerCase()} ${svc.name}`,
          });
        onDone();
        if (e instanceof ApiError && e.code === "service_failed") onFailed?.(svc.unit);
        throw e;
      } finally {
        setBusy(null);
      }
    },
    [onDone, onFailed],
  );

  const act = React.useCallback(
    (svc: ServiceInfo, action: ServiceAction) => {
      const ask = askFor(svc, action);
      if (!ask) return void run(svc, action).catch(() => undefined);
      confirm({ ...ask, onConfirm: () => run(svc, action, true) });
    },
    [confirm, run],
  );

  return { act, busy, confirmNode };
}
