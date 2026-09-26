import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { peekInvite } from "@/server/auth/invites";
import { currentAuth, pendingAuth } from "@/server/auth/session";
import { findById } from "@/server/auth/users";
import { clientInfo } from "@/server/net-zone";
import { getSetting } from "@/server/settings";
import { InviteForm } from "./InviteForm";
import s from "../../auth.module.css";

export const metadata = { title: "Join" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (await currentAuth()) redirect("/");
  const serverName = getSetting("serverName");

  // Came back mid-way (the account exists, two-step still to link): pick up where they left off.
  const pending = await pendingAuth();
  if (pending?.session.pending === "enrol") {
    const row = findById(pending.session.userId);
    return <InviteForm token={token} displayName={row?.display_name ?? ""} role="admin" serverName={serverName} mustEnrol resume username={row?.username ?? ""} />;
  }

  const invite = token.length >= 16 && token.length <= 100 ? peekInvite(token) : null;
  if (!invite) {
    return (
      <div className={s.form}>
        <h2>This invite has expired</h2>
        <p className={s.lede}>Invite links work once and last a week. Ask whoever sent it for a new one.</p>
      </div>
    );
  }
  const { zone } = clientInfo(await headers());
  const mustEnrol = invite.role === "admin" && zone === "away" && getSetting("requireMfaAway");
  return <InviteForm token={token} displayName={invite.display_name ?? ""} role={invite.role} serverName={serverName} mustEnrol={mustEnrol} />;
}
