import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { homeFor } from "@/server/home";
import { Home } from "@/components/home/Home";

export const metadata = { title: "Home" };

export default async function HomePage() {
  const { user } = await requireUser();
  // New accounts see their first run before Home; it sends them back here when it's done or skipped.
  if (getPrefs(user.id).onboarding !== "done") redirect("/welcome");
  const initial = await homeFor(user.id, user.role);
  return (
    <Suspense>
      <Home initial={initial} />
    </Suspense>
  );
}
