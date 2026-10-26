"use client";
import * as React from "react";
import { useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Surface";
import { Actions, PartError, StepHead, firstName, useFlow, useMemberPlan } from "../flow";
import { APPS_URL, openable, type MemberApp } from "./memberApps";
import { Bond } from "../Bond";
import o from "../onboarding.module.css";

/**
 * Household member, first: who asked them here and what Gluon is for them, in plain words, with the
 * apps they can already open. No jargon, nothing to configure.
 */
export function Hello() {
  const plan = useMemberPlan();
  const { next, finish, leaving } = useFlow();
  const { viewer } = usePrefs();
  const { data, error, mutate } = useApi<MemberApp[]>(APPS_URL, { revalidateOnFocus: false });
  const apps = data ? openable(data) : [];
  const admin = plan.admin ?? "the person who runs it";

  return (
    <>
      <StepHead title={`Welcome, ${firstName(viewer.displayName, viewer.username)}`} art={<Bond from="You" to={plan.serverName} draw />}>
        <p>
          {plan.invitedBy ? `${plan.invitedBy} invited you to ${plan.serverName}, the server at home. ` : `This is ${plan.serverName}, the server at home. `}
          Its apps open from here, on any device.
        </p>
      </StepHead>

      <section className={o.stack} aria-labelledby="shared-apps">
        <h2 id="shared-apps" className={o.sectionTitle}>
          Shared with you
        </h2>
        {error && !data ? (
          <PartError message={`Couldn't list your apps. ${error.message}`} onRetry={() => void mutate()} />
        ) : !data ? (
          <ul className={o.tiles} aria-busy>
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className={o.tile}>
                <Skeleton width={40} height={40} radius={10} />
                <Skeleton width={56} height={10} />
              </li>
            ))}
          </ul>
        ) : apps.length === 0 ? (
          <p className={o.note}>Nothing yet. Apps {admin} shares appear on Home by themselves.</p>
        ) : (
          <ul className={`${o.tiles} appear`}>
            {apps.slice(0, 12).map((a) => (
              <li key={a.id} className={o.tile} title={a.name}>
                <AppIcon src={a.icon} name={a.name} size={40} />
                <span>{a.name}</span>
              </li>
            ))}
            {apps.length > 12 && (
              <li className={`${o.tile} ${o.tileMore}`}>
                <span className="num">+{apps.length - 12}</span>
              </li>
            )}
          </ul>
        )}
      </section>

      <Actions
        primary={
          <Button variant="primary" onClick={apps.length ? next : () => finish()} loading={leaving} disabled={!data && !error}>
            {apps.length ? "Choose your apps" : "Open Home"}
          </Button>
        }
      />
    </>
  );
}
