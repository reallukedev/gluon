import type { LineState } from "@/lib/types";

/** Where commands run: the server itself, or one container by name. */
export type TargetId = "host" | `container:${string}`;

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function parseTarget(raw: string | null | undefined): TargetId | null {
  if (!raw) return null;
  if (raw === "host") return "host";
  if (!raw.startsWith("container:")) return null;
  const name = raw.slice("container:".length);
  return CONTAINER_NAME.test(name) ? (`container:${name}` as TargetId) : null;
}

export const containerTarget = (name: string): TargetId => `container:${name}` as TargetId;
export const containerOf = (t: TargetId): string | null => (t === "host" ? null : t.slice("container:".length));

export interface TargetOption {
  id: TargetId;
  name: string;
  state: string;
  line: LineState;
  /** Why it can't be used right now ("Gluon itself", "Stopped"). */
  blocked: string | null;
}

export interface TargetGroup {
  key: string;
  /** The app's name, or the compose project, or "Other containers". */
  name: string;
  icon: string | null;
  href: string | null;
  targets: TargetOption[];
}

export interface TargetList {
  host: { available: boolean; note: string | null; name: string };
  groups: TargetGroup[];
}

/** What a target is like, asked once per visit: its shell, user, folders and programs. */
export interface TargetProbe {
  shell: string;
  user: string;
  home: string | null;
  cwd: string;
  commands: string[];
}

/** One line of the stream for a running command or a terminal session. */
export type TermEvent =
  | { type: "open"; id: string; shell: string; cwd: string | null }
  | { type: "out"; data: string }
  | { type: "exit"; code: number | null; cwd: string | null; ms: number; truncated: boolean; reason: ExitReason }
  | { type: "error"; message: string };

export type ExitReason = "done" | "stopped" | "timeout" | "idle" | "closed";

export interface DirEntry {
  name: string;
  dir: boolean;
}

/** A spec for a known program, trimmed to what the suggestions need (from @withfig/autocomplete). */
export interface SpecArg {
  name?: string;
  description?: string;
  template?: ("filepaths" | "folders")[];
  suggestions?: { name: string; description?: string }[];
  variadic?: boolean;
  optional?: boolean;
}

export interface SpecOption {
  name: string[];
  description?: string;
  args?: SpecArg[];
  repeatable?: boolean;
  persistent?: boolean;
}

export interface SpecNode {
  name: string[];
  description?: string;
  subcommands?: SpecNode[];
  options?: SpecOption[];
  args?: SpecArg[];
}
