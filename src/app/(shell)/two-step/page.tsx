import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { mustSetUpMfa, requireSignedIn } from "@/server/auth/session";
import { clientInfo } from "@/server/net-zone";
import { Page } from "@/components/ui/Surface";

export const metadata = { title: "Two-step sign-in" };

/** Where pages send someone who must set up two-step sign-in. The shell's setup dialog covers it. */
export default async function TwoStepPage() {
  const { user } = await requireSignedIn();
  if (!mustSetUpMfa(user, clientInfo(await headers()).zone)) redirect("/");
  return <Page>{null}</Page>;
}
