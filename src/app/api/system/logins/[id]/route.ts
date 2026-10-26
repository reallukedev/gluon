import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { endSession } from "@/server/system/logins";

/** End a signed-in session (drops the SSH connection and stops what it was running). */
export const DELETE = route(
  { auth: "admin", recent: true },
  async ({ params, user, ip, zone }) => {
    const id = String(params.id ?? "");
    try {
      const s = await endSession(id);
      const where = s.from.ip
        ? ` from ${s.from.ip}`
        : s.kind === "console"
          ? " on the console"
          : "";
      const summary = `Ended ${s.user}'s ${s.kind === "console" ? "console" : "SSH"} session${where}`;
      audit(
        user,
        {
          action: "system.session.end",
          target: s.user,
          summary,
          detail: {
            session: s.id,
            user: s.user,
            ip: s.from.ip,
            tty: s.tty,
            kind: s.kind,
          },
        },
        { ip, zone },
      );
      return { ok: true, message: `${s.user} was disconnected.` };
    } catch (e) {
      if (
        e instanceof AppError &&
        (e.code === "invalid_session" || e.code === "not_found")
      )
        throw e;
      audit(
        user,
        {
          action: "system.session.end",
          target: id,
          summary: "Tried to end a signed-in session",
          detail: { session: id, error: (e as Error).message },
          outcome: "failed",
        },
        { ip, zone },
      );
      throw e;
    }
  },
);
