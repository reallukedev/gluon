import type { ApiError } from "@/lib/client/api";

type Kind = "missing" | "timeout" | "other";

/** What went wrong with a host command, from the API error. */
export function hostFailure(error: Pick<ApiError, "message" | "details">): { kind: Kind; program: string | null; command: string | null } {
  const command = typeof error.details?.command === "string" ? error.details.command : null;
  const first = command?.split(" ")[0] ?? null;
  // Locally the spawn fails; on the server commands run through nsenter, which says it in its own words.
  const gone =
    /spawn (\S+) ENOENT/.exec(error.message) ??
    /nsenter: failed to execute (\S+): No such file/.exec(error.message) ??
    (first ? new RegExp(`(?:^|\\s)(${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}): (?:command )?not found`).exec(error.message) : null);
  const program = gone?.[1] ?? first;
  if (gone) return { kind: "missing", program, command };
  if (/^Timed out/i.test(error.message)) return { kind: "timeout", program, command };
  return { kind: "other", program, command };
}
