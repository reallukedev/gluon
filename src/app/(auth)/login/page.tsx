import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentAuth } from "@/server/auth/session";
import { userCount } from "@/server/auth/users";
import { clientInfo } from "@/server/net-zone";
import { getSetting } from "@/server/settings";
import { safeNext } from "../safe-next";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (userCount() === 0) redirect("/setup");
  const { next } = await searchParams;
  const dest = safeNext(next);
  if (await currentAuth()) redirect(dest);
  const { zone } = clientInfo(await headers());
  return <LoginForm next={dest} zone={zone} serverName={getSetting("serverName")} adminsNeedCode={getSetting("requireMfaAway")} />;
}
