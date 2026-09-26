import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { listSessionsWithDevices, revokeOtherSessions, revokeSession } from "@/server/auth/session";
import { acknowledgeDevice, newDeviceFindingId } from "@/server/auth/devices";
import { resolve } from "@/server/findings";
import { audit } from "@/server/audit";

/** Where you're signed in: one row per session, newest activity first. */
export const GET = route({ auth: "user" }, ({ user, session }) => {
  const list = listSessionsWithDevices(user.id);
  const mine = list.find((s) => s.idHash === session.idHash)?.deviceHash ?? null;
  return list.map((s) => ({
    id: s.idHash.slice(0, 16),
    current: s.idHash === session.idHash,
    /** Another session in this same browser (e.g. an older sign-in that was never signed out). */
    sameDevice: !!mine && s.deviceHash === mine && s.idHash !== session.idHash,
    newDevice: s.newDevice,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    ip: s.ip,
    zone: s.zone,
    userAgent: s.userAgent,
  }));
});

const del = z.union([z.object({ id: z.string().min(8).max(64) }), z.object({ others: z.literal(true) })]);

export const DELETE = route({ auth: "user", body: del }, ({ user, session, body, ip, zone }) => {
  if ("others" in body) {
    const n = revokeOtherSessions(user.id, session.idHash);
    audit(user, { action: "auth.sessions_revoked", summary: `Signed out everywhere else (${n} device${n === 1 ? "" : "s"})` }, { ip, zone });
    return { ok: true, revoked: n };
  }
  const match = listSessionsWithDevices(user.id).find((s) => s.idHash.startsWith(body.id));
  if (!match) throw new AppError("not_found", "That device is already signed out.", 404);
  if (match.idHash === session.idHash) throw new AppError("current", "That's this device. Use Sign out in the menu instead.", 400);
  revokeSession(user.id, match.idHash);
  resolve(newDeviceFindingId(user.id, match.idHash), `${user.displayName} signed that device out`);
  audit(user, { action: "auth.session_revoked", summary: "Signed out a device", detail: { ip: match.ip, userAgent: match.userAgent } }, { ip, zone });
  return { ok: true, revoked: 1 };
});

const ack = z.object({ id: z.string().min(8).max(64) });

/** "That was me": stop flagging a new device. */
export const PATCH = route({ auth: "user", body: ack, recent: true }, ({ user, body, ip, zone }) => {
  const match = listSessionsWithDevices(user.id).find((s) => s.idHash.startsWith(body.id));
  if (!match) throw new AppError("not_found", "That device is already signed out.", 404);
  acknowledgeDevice(user.id, match.idHash);
  audit(user, { action: "auth.device_confirmed", summary: "Confirmed a new device was theirs" }, { ip, zone });
  return { ok: true };
});
