"use client";
import * as React from "react";
import { api } from "@/lib/client/api";
import { CopyButton } from "@/components/ui/CopyButton";
import { Skeleton } from "@/components/ui/Surface";
import s from "./chat.module.css";

/** A QR code for an xmpp: link or invite page, drawn by the server. */
export function ChatQr({ appId, text, label }: { appId: string; text: string; label: string }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    setSvg(null);
    setFailed(false);
    api
      .post<{ svg: string }>(`/api/chat/${encodeURIComponent(appId)}/qr`, { text })
      .then((r) => live && setSvg(r.svg))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [appId, text]);
  if (failed) return null;
  return svg ? <div className={s.qr} role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} /> : <Skeleton width={156} height={156} radius={10} />;
}

/** Chat apps worth suggesting, by platform. Kept short: the ones that support everything Gluon turns on. */
export function AppSuggestions() {
  return (
    <ul className={s.apps} aria-label="Chat apps to use">
      <li>
        <b>iPhone</b>
        <a href="https://apps.apple.com/app/monal-free-xmpp-chat/id1637078500" target="_blank" rel="noopener noreferrer">
          Monal
        </a>
      </li>
      <li>
        <b>Android</b>
        <a href="https://conversations.im/" target="_blank" rel="noopener noreferrer">
          Conversations
        </a>
      </li>
      <li>
        <b>Computer</b>
        <a href="https://gajim.org/" target="_blank" rel="noopener noreferrer">
          Gajim
        </a>
        <span className={s.muted}>or</span>
        <a href="https://dino.im/" target="_blank" rel="noopener noreferrer">
          Dino
        </a>
      </li>
    </ul>
  );
}

/** "luke@chat.example.com" with the @ quieter, as people read an address. */
export function Jid({ jid }: { jid: string }) {
  const at = jid.indexOf("@");
  if (at < 0) return <>{jid}</>;
  return (
    <>
      {jid.slice(0, at)}
      <span className={s.at}>@</span>
      {jid.slice(at + 1)}
    </>
  );
}

/** What someone needs to sign in: address, password, a code to scan, and which app to get. Shown once. */
export function Credentials({ appId, jid, password }: { appId: string; jid: string; password: string | null }) {
  const message = password
    ? `Your chat account is ready.\nAddress: ${jid}\nPassword: ${password}\nUse any XMPP app: Monal on iPhone, Conversations on Android, Gajim on a computer.`
    : `Your chat address is ${jid}. Use any XMPP app: Monal on iPhone, Conversations on Android, Gajim on a computer.`;
  return (
    <div className={s.card}>
      <div className={s.qrCol}>
        <ChatQr appId={appId} text={`xmpp:${jid}`} label={`QR code for ${jid}`} />
        <span className={s.qrHint}>Scan in the chat app to fill in the address</span>
      </div>
      <div className={s.form}>
        <dl className={s.creds}>
          <div className={s.cred}>
            <dt>Address</dt>
            <dd>
              <span className={s.credValue}>
                <Jid jid={jid} />
              </span>
              <CopyButton value={jid} size="sm" label={`Copy ${jid}`} />
            </dd>
          </div>
          {password && (
            <div className={s.cred}>
              <dt>Password</dt>
              <dd>
                <span className={s.credValue}>{password}</span>
                <CopyButton value={password} size="sm" label="Copy the password" />
              </dd>
            </div>
          )}
        </dl>
        <AppSuggestions />
        <div>
          <CopyButton value={message} variant="secondary">
            Copy sign-in details
          </CopyButton>
        </div>
        {password && <p className={s.cardNote}>Gluon doesn&rsquo;t keep this password. Pass it on now; they can change it in their chat app.</p>}
      </div>
    </div>
  );
}
