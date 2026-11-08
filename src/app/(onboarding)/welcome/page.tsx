import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { planFor, releaseLegacySidebar } from "@/server/onboarding";
import { Welcome } from "@/components/onboarding/Welcome";

export const metadata = { title: "Welcome" };

export default async function WelcomePage() {
  const { user, session } = await requireUser();
  if (getPrefs(user.id).onboarding === "done") redirect("/");
  releaseLegacySidebar(user.id);
  return <Welcome plan={planFor(user, session.zone)} />;
}
