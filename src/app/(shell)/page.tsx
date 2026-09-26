import { Suspense } from "react";
import { requireUser } from "@/server/auth/session";
import { homeFor } from "@/server/home";
import { Home } from "@/components/home/Home";

export const metadata = { title: "Home" };

export default async function HomePage() {
  const { user } = await requireUser();
  const initial = homeFor(user.id, user.role);
  return (
    <Suspense>
      <Home initial={initial} />
    </Suspense>
  );
}
