import { headers } from "next/headers";
import QRCode from "qrcode";
import { clientInfo } from "@/server/net-zone";
import { findChatInvite } from "@/server/chat/public";
import { param } from "@/app/api/docker/params";
import s from "../../../auth.module.css";
import c from "./invite.module.css";

export const metadata = { title: "Join the chat", robots: { index: false } };

type Platform = "ios" | "android" | "desktop";

const APPS: Record<Platform, { name: string; href: string; where: string }> = {
  ios: { name: "Monal", href: "https://apps.apple.com/app/monal-free-xmpp-chat/id1637078500", where: "the App Store" },
  android: { name: "Conversations", href: "https://play.google.com/store/apps/details?id=eu.siacs.conversations", where: "Google Play or F-Droid" },
  desktop: { name: "Gajim", href: "https://gajim.org/download/", where: "gajim.org" },
};

function platformOf(ua: string): Platform {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

/**
 * Where a chat invite link leads (Prosody's invites_page). Says which app to get for this device,
 * then hands the invite to it. Nothing here signs anyone in to Gluon.
 */
export default async function ChatInvitePage({ params }: { params: Promise<{ host: string; token: string }> }) {
  const { host, token } = await params;
  const h = await headers();
  const { ip } = clientInfo(h);
  const invite = await findChatInvite(param(host).toLowerCase(), param(token), ip).catch(() => null);

  if (!invite) {
    return (
      <div className={s.form}>
        <h2>This invite doesn&rsquo;t work any more</h2>
        <p className={s.lede}>It was used, cancelled or ran out of time. Ask whoever sent it for a new link.</p>
      </div>
    );
  }

  const platform = platformOf(h.get("user-agent") ?? "");
  const app = APPS[platform];
  const others = (Object.keys(APPS) as Platform[]).filter((p) => p !== platform);
  const qr = platform !== "desktop" ? null : await QRCode.toString(invite.uri, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#0000" } });
  const until = new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(invite.expires);

  return (
    <div className={s.form} data-wide="">
      <h2>You&rsquo;re invited to chat on {invite.host}</h2>
      <p className={s.lede}>
        {invite.username ? (
          <>
            Your address will be <b className="mono">{invite.username}@{invite.host}</b>. You choose your password in the app.
          </>
        ) : (
          <>You choose a username and password in the app. Your address ends in @{invite.host}.</>
        )}
      </p>
      <ol className={s.steps}>
        <li>
          <span>
            Get <a className={c.app} href={app.href} rel="noopener noreferrer">{app.name}</a> from {app.where}.{" "}
            <span className={c.muted}>Already have a chat app? Skip this.</span>
          </span>
        </li>
        <li>
          <span>Come back here and open the invite. The app fills everything in.</span>
        </li>
      </ol>
      <a className={c.open} href={invite.uri}>
        Open the invite in {platform === "desktop" ? "your chat app" : app.name}
      </a>
      {qr && (
        <div className={c.scan}>
          <div className={c.qr} role="img" aria-label="QR code of the invite" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className={s.foot}>Rather chat on your phone? Scan this with its camera.</p>
        </div>
      )}
      <p className={s.foot}>
        Works until {until}. Other apps:{" "}
        {others.map((p, i) => (
          <span key={p}>
            {i > 0 ? " or " : ""}
            <a className={s.linkButton} href={APPS[p].href} rel="noopener noreferrer">
              {APPS[p].name}
            </a>{" "}
            ({p === "ios" ? "iPhone" : p === "android" ? "Android" : "computer"})
          </span>
        ))}
        .
      </p>
    </div>
  );
}
