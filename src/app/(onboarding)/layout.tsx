import { cookies } from "next/headers";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { getSetting } from "@/server/settings";
import { PrefsProvider } from "@/components/PrefsProvider";
import { ReauthDialog } from "@/components/shell/ReauthDialog";
import { ForcePasswordChange } from "@/components/shell/ForcePasswordChange";

/**
 * Full-screen pages for a signed-in person, outside the app shell (first run). Same prefs, theme and
 * "confirm it's you" handling as the shell, none of its navigation.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const { user, session } = await requireUser();
  const tzCookie = (await cookies()).get("gluon_tz")?.value;
  const tz = tzCookie && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(decodeURIComponent(tzCookie)) ? decodeURIComponent(tzCookie) : null;
  return (
    <PrefsProvider
      tz={tz}
      initial={getPrefs(user.id)}
      serverName={getSetting("serverName")}
      viewer={{ id: user.id, username: user.username, displayName: user.displayName, role: user.role, mfa: user.mfa, zone: session.zone, mustChangePassword: user.mustChangePassword }}
    >
      {children}
      <ReauthDialog />
      {user.mustChangePassword && <ForcePasswordChange />}
    </PrefsProvider>
  );
}
