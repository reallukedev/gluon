import "server-only";

/** An error whose message is safe and useful to show the person who caused it. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} doesn't exist (any more).`, 404);
export const forbidden = (msg = "You don't have access to that.") => new AppError("forbidden", msg, 403);
export const conflict = (msg: string) => new AppError("conflict", msg, 409);
export const badRequest = (msg: string, details?: Record<string, unknown>) => new AppError("bad_request", msg, 400, details);

/** The schema's own message for a zod issue, or null for zod's defaults ("Too small: expected…"), which read as code. */
export const ownIssueMessage = (m: string | undefined): string | null =>
  m && !/^(Invalid|Too (small|big)|Unrecognized key|Expected |Required)/.test(m) ? m : null;

/** "config.timeoutSec" → "the timeout", for "Check the timeout." */
export function fieldWords(path: string | null | undefined): string | null {
  const last = path?.split(".").filter((s) => s && !/^\d+$/.test(s)).at(-1);
  if (!last) return null;
  const words = last.replace(/(Sec|Ms|Min|Id)$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return null;
  return `the ${words.replace(/\b(url|api|ip|dns|smtp|tls|ssh|id)\b/g, (w) => w.toUpperCase())}`;
}
