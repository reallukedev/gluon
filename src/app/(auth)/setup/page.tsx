import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { userCount } from "@/server/auth/users";
import { ensureSetupCode } from "@/server/auth/setup";
import { clientInfo } from "@/server/net-zone";
import { getSetting } from "@/server/settings";
import { ZoneLine } from "@/components/auth/ZoneLine";
import { SetupForm } from "./SetupForm";
import s from "../auth.module.css";

export const metadata = { title: "Set up" };

export default async function SetupPage() {
  if (userCount() > 0) redirect("/login");
  const { zone } = clientInfo(await headers());
  const serverName = getSetting("serverName");
  if (zone !== "home") {
    // Claiming a fresh server is only possible from the home network (the API refuses it too).
    return (
      <div className={s.form}>
        <h2>Finish setting up at home</h2>
        <ZoneLine zone="away" serverName={serverName}>
          You're reaching this server over the internet. The first admin account can only be created from a device on the home network.
        </ZoneLine>
        <p className={s.foot}>Open Gluon on a phone or computer connected to your home Wi-Fi, at the server's local address.</p>
      </div>
    );
  }
  ensureSetupCode();
  return <SetupForm />;
}
