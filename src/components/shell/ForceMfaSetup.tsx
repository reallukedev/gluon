"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { api } from "@/lib/client/api";
import { usePrefs, useViewer } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { TwoStepSetup, type Enrolment } from "@/components/auth/TwoStepSetup";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import d from "@/components/ui/dialog.module.css";

/**
 * The server's rules (Settings → Server) need two-step sign-in for this person and they haven't set
 * it up. At home they set it up here before anything else; away from home it can't be done (a stolen
 * cookie could link its own phone), so the only way on is to come back home or sign out.
 */
export function ForceMfaSetup() {
  const router = useRouter();
  const viewer = useViewer();
  const { serverName } = usePrefs();
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const away = viewer.zone === "away";

  const begin = React.useCallback(() => api.post<Enrolment>("/api/me/mfa", { action: "begin" }), []);
  const confirm = React.useCallback(
    (e: Enrolment, code: string) => api.post<{ recoveryCodes: string[] }>("/api/me/mfa", { action: "confirm", secret: e.secret, ticket: e.ticket, code }).then((r) => r.recoveryCodes),
    [],
  );

  async function signOut() {
    setLeaving(true);
    await api.post("/api/auth/logout").catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  function carryOn() {
    router.replace("/");
    router.refresh();
  }

  return (
    <Dialog.Root open modal="trap-focus" onOpenChange={() => undefined} disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Backdrop className={d.backdrop} data-motion-gentle="" />
        <Dialog.Viewport className={d.viewport}>
          <Dialog.Popup className={d.popup} data-motion-gentle="">
            <div className={d.head}>
              <div className={d.headText}>
                <Dialog.Title className={d.title}>{codes ? "Keep these recovery codes" : "Set up two-step sign-in"}</Dialog.Title>
                <Dialog.Description className={d.description}>
                  {codes
                    ? "If you lose your phone, one of these gets you in. Each works once. Save them somewhere other than this device."
                    : away
                      ? `${serverName} needs two-step sign-in for you, and it can only be set up from your home network. Sign in there once to set it up, then you can use Gluon from anywhere.`
                      : `${serverName} needs two-step sign-in for you. Link an authenticator app on your phone to carry on.`}
                </Dialog.Description>
              </div>
            </div>
            {!away && (
              <div className={d.body}>
                {codes ? (
                  <RecoveryCodes codes={codes} username={viewer.username} serverName={serverName} />
                ) : (
                  <TwoStepSetup begin={begin} confirm={confirm} onDone={setCodes} confirmLabel="Turn it on" />
                )}
              </div>
            )}
            <div className={d.foot}>
              <Button variant="ghost" onClick={() => void signOut()} loading={leaving}>
                Sign out
              </Button>
              {codes && (
                <Button variant="primary" onClick={carryOn}>
                  I&apos;ve saved them
                </Button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
