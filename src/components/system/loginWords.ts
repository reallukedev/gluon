import type { LiveSession, LoginZone } from "@/lib/system-types";

/** Plain words for sign-in data, shared by the Sign-ins tab and the Home widget. */

export const ZONE_WORDS: Record<LoginZone, string> = {
  home: "Home network",
  away: "Outside your home network",
  local: "On the server itself",
};

export const KIND_WORDS: Record<LiveSession["kind"], string> = {
  shell: "Terminal",
  command: "Running a command",
  files: "Copying files",
  tunnel: "Tunnel only",
  console: "Keyboard and screen",
  desktop: "Desktop",
};

export const KIND_HELP: Record<LiveSession["kind"], string> = {
  shell: "An interactive SSH terminal.",
  command: "SSH ran one command without a terminal (ssh server command).",
  files: "An SFTP or file-copy connection.",
  tunnel: "Connected without a terminal and running nothing: port forwarding, or a connection other SSH commands reuse.",
  console: "Signed in on a keyboard and screen plugged into the server.",
  desktop: "A graphical desktop session.",
};

export const KIND_ORDER: LiveSession["kind"][] = ["console", "desktop", "shell", "files", "command", "tunnel"];

export function methodWords(method: LiveSession["method"], keyLabel: string | null): string | null {
  if (method === "key") return keyLabel ? `Key “${keyLabel}”` : "A key";
  if (method === "password") return "Password";
  if (method === "keyboard") return "Password prompt";
  if (method === "other") return "Other sign-in method";
  return null;
}

/** "luke", "luke and ali", "luke, ali and 2 others" */
export function peopleList(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
