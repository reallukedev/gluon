import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SWRConfig } from "swr";
import { requireUser } from "@/server/auth/session";
import { getPrefs } from "@/server/prefs";
import { homeFor } from "@/server/home";
import { homePrefetch } from "@/server/home-prefetch";
import { HOME_SEEN } from "@/lib/home";
import { Home } from "@/components/home/Home";

export const metadata = { title: "Home" };

export default async function HomePage() {
  const { user } = await requireUser();
  // New accounts see their first run before Home; it sends them back here when it's done or skipped.
  if (getPrefs(user.id).onboarding !== "done") redirect("/welcome");
  const [initial, jar] = await Promise.all([homeFor(user.id, user.role), cookies()]);
  const fallback = await homePrefetch(user, initial.layout);
  return (
    <SWRConfig value={{ fallback }}>
      <Suspense>
        <Home initial={initial} entrance={jar.get(HOME_SEEN)?.value !== "1"} />
      </Suspense>
    </SWRConfig>
  );
}
