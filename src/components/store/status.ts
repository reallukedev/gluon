import type { LineState } from "@/lib/types";
import type { InstalledInfo } from "./types";

const WORKING: Partial<Record<InstalledInfo["state"], string>> = {
  installing: "Installing",
  updating: "Updating",
  uninstalling: "Uninstalling",
  starting: "Starting",
  stopping: "Stopping",
  restarting: "Restarting",
};

/** How an installed app reads in the store: the StateLine and the words beside it. */
export function installedLine(i: InstalledInfo): { line: LineState; label: string } | null {
  if (i.state === "not-installed") return null;
  const working = WORKING[i.state];
  if (working) return { line: "starting", label: i.progress ? `${working} · ${i.progress}%` : working };
  if (i.latest) return { line: "attention", label: "Update available" };
  if (i.state === "stopped") return { line: "stopped", label: "Installed, stopped" };
  if (i.state === "unknown") return { line: "unknown", label: "Installed" };
  return { line: "running", label: "Installed" };
}
