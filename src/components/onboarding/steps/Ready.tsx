"use client";
import * as React from "react";
import type { HomeLayout } from "@/lib/home";
import { useApi } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Surface";
import { Actions, StepHead, useFlow, useMemberPlan } from "../flow";
import { APPS_URL, HOME_URL, appsOnHome, type MemberApp } from "./memberApps";
import o from "../onboarding.module.css";

/** Household member, last: what their Home now holds (read back from the server) and what to do if something breaks. */
export function Ready() {
  const plan = useMemberPlan();
  const { finish, leaving } = useFlow();
  const home = useApi<{ layout: HomeLayout }>(HOME_URL, { revalidateOnFocus: false });
  const apps = useApi<MemberApp[]>(APPS_URL, { revalidateOnFocus: false });
  const n = home.data && apps.data ? appsOnHome(home.data.layout, apps.data) : null;
  const admin = plan.admin ?? "the admin";

  return (
    <>
      <StepHead title={n === null ? "Your Home page" : n > 0 ? `Your Home has ${n === 1 ? "1 app" : `${n} apps`}` : "Your Home is ready"}>
        {n === null && !home.error && !apps.error ? (
          <Skeleton width="70%" height={14} />
        ) : (
          <p>{n ? "Open them from any device you sign in on." : "Apps appear there as soon as they're shared with you."}</p>
        )}
      </StepHead>

      <ul className={o.plain}>
        <li>
          {plan.canSeeStatus
            ? `Something broken? Choose Report a problem on Status and ${admin} will see it.`
            : `Something broken? Let ${admin} know.`}
        </li>
        <li>Collection, at the bottom of Home, adds apps and widgets. Press and hold, or right-click, anything there to unpin it.</li>
        <li>Theme and text size are in Settings.</li>
      </ul>

      <Actions
        primary={
          <Button variant="primary" onClick={() => finish()} loading={leaving}>
            Open Home
          </Button>
        }
      />
    </>
  );
}
