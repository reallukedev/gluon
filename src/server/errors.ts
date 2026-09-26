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
