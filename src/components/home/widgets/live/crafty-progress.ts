// Following a Start, Stop or Restart until Crafty reports the server got there. Crafty queues the command and
// answers at once, then saves fresh stats when the server starts or stops and every 30 seconds while it runs, so
// "done" is read from the server's state, never from the command's answer.
import type { CraftyAction, CraftyServer } from "@/lib/widgets-types";

export interface Pending {
  action: CraftyAction;
  since: number;
  /** The run marker before the command, so a restart is done only once a new run answers. */
  run: string | null;
}

export type Verdict =
  | { kind: "wait" }
  | { kind: "done" }
  /** It went wrong: say what Crafty reports. */
  | { kind: "failed"; message: string }
  /** It's taking longer than it should: say so, and keep watching in case it gets there. */
  | { kind: "slow"; message: string };

/** A big modpack can take a few minutes to start; past this, say so instead of spinning. */
export const START_LIMIT_MS = 5 * 60_000;
/** A start that hasn't even launched the process by now didn't take (EULA, missing Java, a bad command). */
export const LAUNCH_LIMIT_MS = 45_000;

export function settle(p: Pending, s: CraftyServer, now: number): Verdict {
  const took = now - p.since;
  switch (p.action) {
    case "start":
    case "restart": {
      const fresh = p.action === "start" || p.run === null || (s.run !== null && s.run !== p.run);
      if (fresh && s.state === "running") return { kind: "done" };
      if (s.state === "crashed") return { kind: "failed", message: "Crafty says it crashed while starting. Its console in Crafty shows why." };
      // A restart first waits for the old run to stop.
      if (!s.running && took > LAUNCH_LIMIT_MS + (p.action === "restart" ? s.stopTimeoutMs : 0)) {
        return { kind: "failed", message: "Crafty didn't get it running. Its console in Crafty shows why: often the EULA, the Java version or a bad start command." };
      }
      if (s.state === "unresponsive" || took > START_LIMIT_MS) {
        return { kind: "slow", message: "It's been running a while but still isn't answering players. Its console in Crafty shows what it's doing." };
      }
      return { kind: "wait" };
    }
    case "stop":
    case "kill": {
      if (!s.running) return { kind: "done" };
      const limit = p.action === "kill" ? 30_000 : s.stopTimeoutMs + 30_000;
      if (took > limit) {
        return p.action === "kill"
          ? { kind: "failed", message: "Crafty couldn't end the process. Restarting Crafty itself will." }
          : { kind: "slow", message: "It's still shutting down. You can wait, or force-stop it: anything since the world last saved is lost." };
      }
      return { kind: "wait" };
    }
  }
}

/**
 * When to ask Crafty again, or null to stop asking. Each poll costs Crafty two reads, so a command that's taking
 * long is asked about less and less often: every 2 s for the first half minute, then 5 s, 10 s and 30 s, and not
 * at all once it has been slow past the five-minute mark (its message stays; the widget's own refresh carries on).
 */
export function pollDelay(p: Pending, v: Verdict, now: number): number | null {
  if (v.kind === "done" || v.kind === "failed") return null;
  const took = now - p.since;
  if (took >= START_LIMIT_MS && v.kind === "slow") return null;
  // A command that never reports slow still can't be followed forever.
  if (took >= 2 * START_LIMIT_MS) return null;
  if (took < 30_000) return 2000;
  if (took < 90_000) return 5000;
  if (took < 3 * 60_000) return 10_000;
  return 30_000;
}

/** "0:42", "3:05": how long an action has been going, for the row while it settles. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
