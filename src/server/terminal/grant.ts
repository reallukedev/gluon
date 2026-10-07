import "server-only";
import { hasRecentAuth, type Session } from "../auth/session";
import { AppError } from "../errors";

/**
 * Confirming it's you once covers a stretch of terminal work: after a re-auth, this sign-in session
 * can keep running commands while it stays busy (30 minutes between commands), for up to 4 hours.
 * Everything else that needs a recent sign-in keeps the normal 10-minute window. In memory, so a
 * Gluon restart asks again.
 */

const IDLE_MS = 30 * 60_000;
const MAX_MS = 4 * 60 * 60_000;

type Grant = { since: number; last: number };
type G = typeof globalThis & { __gluonTerminalGrants?: Map<string, Grant> };
const g = globalThis as G;
const grants = () => (g.__gluonTerminalGrants ??= new Map());

export function requireTerminalAuth(session: Session, at = Date.now()) {
  const m = grants();
  if (hasRecentAuth(session)) {
    const cur = m.get(session.idHash);
    // A fresh re-auth starts a new stretch; one that only extends an old grant keeps its start.
    const since = cur && cur.since >= session.recentAuthAt ? cur.since : session.recentAuthAt;
    m.set(session.idHash, { since, last: at });
    return;
  }
  const cur = m.get(session.idHash);
  if (cur && at - cur.last < IDLE_MS && at - cur.since < MAX_MS) {
    cur.last = at;
    return;
  }
  m.delete(session.idHash);
  throw new AppError("reauth", "Confirm it's you to continue.", 403);
}
