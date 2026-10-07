import "server-only";
import { AppError } from "../errors";
import { hasRecentAuth, type Session } from "../auth/session";

/**
 * For changes that decide what the household can reach (sharing a connection, what members may see or press):
 * the same "confirm it's you" as `route({ recent: true })`, for routes where only some requests need it.
 */
export function requireRecentAuth(session: Session) {
  if (!hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
}
