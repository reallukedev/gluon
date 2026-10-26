"use client";
import * as React from "react";
import { api } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import { TwoStepSetup, type Enrolment } from "@/components/auth/TwoStepSetup";
import { ZoneLine } from "@/components/auth/ZoneLine";
import { Button } from "@/components/ui/Button";
import { Actions, StepHead, useAdminPlan, useFlow } from "../flow";
import o from "../onboarding.module.css";

/**
 * Admin, only when Gluon is on the internet (or they're signed in from away) and they don't use
 * two-step yet. Explains why in terms of this server, then links an authenticator app right here.
 */
export function SecurityStep() {
  const plan = useAdminPlan();
  const { next, headingRef } = useFlow();
  const { viewer } = usePrefs();
  const [stage, setStage] = React.useState<"why" | "link" | "codes">("why");
  const [codes, setCodes] = React.useState<string[] | null>(null);

  // The codes replace the whole step: say so to screen readers by moving focus to the new title.
  React.useEffect(() => {
    if (stage === "codes") headingRef.current?.focus();
  }, [stage, headingRef]);

  const begin = React.useCallback(() => api.post<Enrolment>("/api/me/mfa", { action: "begin" }), []);
  const confirm = React.useCallback(
    (e: Enrolment, code: string) => api.post<{ recoveryCodes: string[] }>("/api/me/mfa", { action: "confirm", secret: e.secret, ticket: e.ticket, code }).then((r) => r.recoveryCodes),
    [],
  );

  if (stage === "codes" && codes) {
    return (
      <>
        <StepHead title="Save your recovery codes">
          <p>Two-step sign-in is on. If you lose your phone, one of these gets you in.</p>
        </StepHead>
        <RecoveryCodes codes={codes} username={viewer.username} serverName={plan.serverName} />
        <Actions
          back={false}
          primary={
            <Button variant="primary" onClick={next}>
              I&apos;ve saved them, continue
            </Button>
          }
        />
      </>
    );
  }

  const { publicAt, zone } = plan.reach;
  return (
    <>
      <StepHead title="Reaching Gluon from outside">
        {publicAt ? (
          <p>
            Anyone who finds <span className="mono">{publicAt}</span> gets a sign-in page, and only your password stands in the way.
          </p>
        ) : (
          <p>You&apos;re signed in over the internet, so Gluon can be reached from outside.</p>
        )}
        <p>
          Two-step sign-in adds a code from your phone, so a leaked password isn&apos;t enough.
          {plan.requireMfaAway ? " Admins need it to sign in from away anyway." : ""}
        </p>
      </StepHead>

      {zone === "away" && <ZoneLine zone="away" serverName={plan.serverName} />}

      {stage === "link" ? (
        <TwoStepSetup
          begin={begin}
          confirm={confirm}
          confirmLabel="Turn on two-step sign-in"
          onCancel={() => setStage("why")}
          onDone={(c) => {
            setCodes(c);
            setStage("codes");
          }}
        />
      ) : (
        <p className={o.note}>About a minute: scan a code with an authenticator app like 1Password or Authy, then type the 6 digits.</p>
      )}

      <Actions
        skip={stage === "why" ? { label: "Not now", onClick: next } : undefined}
        primary={
          stage === "why" ? (
            <Button variant="primary" onClick={() => setStage("link")}>
              Set up two-step sign-in
            </Button>
          ) : undefined
        }
      />
    </>
  );
}
