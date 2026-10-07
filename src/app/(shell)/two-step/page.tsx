import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { mustSetUpMfa, requireSignedIn } from "@/server/auth/session";
import { clientInfo } from "@/server/net-zone";
import { Page } from "@/components/ui/Surface";

export const metadata = { title: "Two-step sign-in" };

/**
 * Where pages send someone who must set up two-step sign-in first. It renders nothing of its own:
 * the shell's setup dialog covers it, and once that's done the person is sent home.
 */
export default async function TwoStepPage() {
  const { user } = await requireSignedIn();
  if (!mustSetUpMfa(user, clientInfo(await headers()).zone)) redirect("/");
  return <Page>{null}</Page>;
}
