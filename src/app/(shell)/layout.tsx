import { cookies } from "next/headers";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { getSetting } from "@/server/settings";
import { counts } from "@/server/findings";
import { listPins } from "@/server/pins";
import { all, now, one } from "@/server/db";
import { PrefsProvider } from "@/components/PrefsProvider";
import { Shell } from "@/components/shell/Shell";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const { user, session } = await requireUser();
  const prefs = getPrefs(user.id);
  const isAdmin = user.role === "admin";
  const c = isAdmin ? counts() : { fault: 0, attention: 0 };
  const memberFiles = !isAdmin && (one<{ n: number }>("SELECT COUNT(*) AS n FROM file_grants WHERE user_id = ?", user.id)?.n ?? 0) > 0;
  const initial = {
    ...c,
    reports: isAdmin ? (one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL")?.n ?? 0) : 0,
    pins: listPins(user.id),
    announcements: all<{ id: string; message: string; app_id: string | null }>(
      "SELECT id, message, app_id FROM announcements WHERE until IS NULL OR until > ? ORDER BY created_at DESC LIMIT 5",
      now(),
    ),
  };
  const tzCookie = (await cookies()).get("gluon_tz")?.value;
  const tz = tzCookie && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(decodeURIComponent(tzCookie)) ? decodeURIComponent(tzCookie) : null;
  return (
    <PrefsProvider
      tz={tz}
      initial={prefs}
      serverName={getSetting("serverName")}
      viewer={{ id: user.id, username: user.username, displayName: user.displayName, role: user.role, mfa: user.mfa, zone: session.zone, mustChangePassword: user.mustChangePassword }}
    >
      <Shell memberStatus={getSetting("householdCanSeeStatus")} memberFiles={memberFiles} initial={initial}>
        {children}
      </Shell>
    </PrefsProvider>
  );
}
