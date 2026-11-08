import "server-only";
import { AppError } from "../errors";
import { hasRecentAuth, type Session } from "../auth/session";

/**
 * For routes where only some requests decide what the household can reach (sharing a connection, what
 * members may see or press).
 */
export function requireRecentAuth(session: Session) {
  if (!hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
}
