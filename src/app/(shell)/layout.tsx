import { cookies } from "next/headers";
import { mustSetUpMfa, requireSignedIn } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { getSetting } from "@/server/settings";
import { counts } from "@/server/findings";
import { listPins } from "@/server/pins";
import { one } from "@/server/db";
import { currentAnnouncements } from "@/server/people/household";
import { PrefsProvider } from "@/components/PrefsProvider";
import { Shell } from "@/components/shell/Shell";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  // Signed in is enough here: the shell itself shows the two-step setup when the rules call for it,
  // and the pages inside (requireUser) send people to /two-step until it's done.
  const { user, session } = await requireSignedIn();
  const prefs = getPrefs(user.id);
  const isAdmin = user.role === "admin";
  const c = isAdmin ? counts() : { fault: 0, attention: 0 };
  const memberFiles = !isAdmin && (one<{ n: number }>("SELECT COUNT(*) AS n FROM file_grants WHERE user_id = ?", user.id)?.n ?? 0) > 0;
  const initial = {
    ...c,
    reports: isAdmin ? (one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL")?.n ?? 0) : 0,
    pins: listPins(user.id),
    announcements: (await currentAnnouncements(user, 5)).map(({ id, message, app_id }) => ({ id, message, app_id })),
  };
  const tzCookie = (await cookies()).get("gluon_tz")?.value;
  const tz = tzCookie && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(decodeURIComponent(tzCookie)) ? decodeURIComponent(tzCookie) : null;
  return (
    <PrefsProvider
      tz={tz}
      initial={prefs}
      serverName={getSetting("serverName")}
      viewer={{ id: user.id, username: user.username, displayName: user.displayName, role: user.role, mfa: user.mfa, zone: session.zone, mustChangePassword: user.mustChangePassword, mustSetUpMfa: mustSetUpMfa(user, session.zone) }}
    >
      <Shell memberStatus={getSetting("householdCanSeeStatus")} memberFiles={memberFiles} initial={initial}>
        {children}
      </Shell>
    </PrefsProvider>
  );
}
