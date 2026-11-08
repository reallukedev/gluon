import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { closedInvite, peekInvite } from "@/server/auth/invites";
import { currentAuth, pendingAuth } from "@/server/auth/session";
import { findById } from "@/server/auth/users";
import { clientInfo } from "@/server/net-zone";
import { getSetting } from "@/server/settings";
import { LinkButton } from "@/components/ui/Button";
import { InviteForm } from "./InviteForm";
import s from "../../auth.module.css";
import { mfaRequired } from "@/server/auth/policy";

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

  const plausible = token.length >= 16 && token.length <= 100;
  const invite = plausible ? peekInvite(token) : null;
  if (!invite) {
    const why = plausible ? closedInvite(token) : null;
    return (
      <div className={s.form}>
        <h1>{why === "used" ? "This invite has been used" : why === "expired" ? "This invite has expired" : "This invite doesn't work"}</h1>
        <p className={s.lede}>
          {why === "used"
            ? "Each link works once. If you made an account with it, sign in. If not, ask whoever sent it for a new one."
            : why === "expired"
              ? "Links last a week. Ask whoever sent it for a new one."
              : "It may have been cancelled, or the link is incomplete. Ask whoever sent it for a new one."}
        </p>
        {why === "used" && (
          <LinkButton href="/login" variant="primary" size="lg" block>
            Sign in
          </LinkButton>
        )}
      </div>
    );
  }
  const { zone } = clientInfo(await headers());
  const mustEnrol = mfaRequired(invite.role, zone);
  return <InviteForm token={token} displayName={invite.display_name ?? ""} role={invite.role} serverName={serverName} mustEnrol={mustEnrol} />;
}
