import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { planFor, releaseLegacySidebar } from "@/server/onboarding";
import { Welcome } from "@/components/onboarding/Welcome";

export const metadata = { title: "Welcome" };

/** First run for a new account. Once finished or skipped it's gone for good: this page sends people Home. */
export default async function WelcomePage() {
  const { user, session } = await requireUser();
  if (getPrefs(user.id).onboarding === "done") redirect("/");
  releaseLegacySidebar(user.id);
  return <Welcome plan={planFor(user, session.zone)} />;
}
