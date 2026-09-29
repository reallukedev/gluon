"use client";
import * as React from "react";
import { ApiError, useApi } from "@/lib/client/api";
import { pinAppsToHome, unpinAppsFromHome } from "@/components/home/pinned";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Surface";
import { Actions, PartError, StepHead, useFlow, useMemberPlan } from "../flow";
import { APPS_URL, openable, type MemberApp } from "./memberApps";
import o from "../onboarding.module.css";

/**
 * Household member: which of their apps sit on Home, one card each. The picked ones are pinned (in this order),
 * the rest unpinned. Everything else on Home stays.
 */
export function AppsStep() {
  const plan = useMemberPlan();
  const { next } = useFlow();
  const apps = useApi<MemberApp[]>(APPS_URL, { revalidateOnFocus: false });
  const list = React.useMemo(() => (apps.data ? openable(apps.data) : []), [apps.data]);
  const [picked, setPicked] = React.useState<Set<string> | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Everything starts picked: most people want all of it, and unticking is quicker than finding.
  // (Derived until the first change, so the first render with apps already shows them picked.)
  const everything = React.useMemo(() => new Set(list.map((a) => a.id)), [list]);
  const chosen = picked ?? everything;
  const all = list.length > 0 && list.every((a) => chosen.has(a.id));
  const n = list.filter((a) => chosen.has(a.id)).length;

  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const s = new Set(p ?? everything);
      if (on) s.add(id);
      else s.delete(id);
      return s;
    });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await unpinAppsFromHome(list.filter((a) => !chosen.has(a.id)).map((a) => a.id));
      await pinAppsToHome(list.filter((a) => chosen.has(a.id)));
      next();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setError(e instanceof Error ? e.message : "Couldn't save your Home page.");
    }
  }

  return (
    <>
      <StepHead title="Pick the apps for your Home">
        <p>The ones you pick sit on your Home page, ready to open. The rest are still there when you search.</p>
      </StepHead>

      {apps.error && !apps.data ? (
        <PartError message={`Couldn't list your apps. ${apps.error.message}`} onRetry={() => void apps.mutate()} />
      ) : !apps.data ? (
        <ul className={o.picks} aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className={o.pick}>
              <Skeleton width={17} height={17} radius={4} />
              <Skeleton width={32} height={32} radius={8} />
              <Skeleton width="40%" height={12} />
            </li>
          ))}
        </ul>
      ) : list.length === 0 ? (
        <p className={o.note}>Nothing has been shared with you yet. When {plan.admin ?? "the admin"} shares an app, it shows up on your Home page by itself.</p>
      ) : (
        <div className={o.stack}>
          <div className={o.picksHead}>
            <span className="num" aria-live="polite">
              {n} of {list.length} picked
            </span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(all ? new Set() : new Set(list.map((a) => a.id)))}>
              {all ? "Clear all" : "Pick all"}
            </Button>
          </div>
          <ul className={`${o.picks} appear`} aria-label="Your apps">
            {list.map((a) => (
              <li key={a.id}>
                <label className={o.pick}>
                  <Checkbox checked={chosen.has(a.id)} onChange={(on) => toggle(a.id, on)} />
                  <AppIcon src={a.icon} name={a.name} size={32} />
                  <span className={o.pickText}>
                    <b title={a.name}>{a.name}</b>
                    {a.description && <span title={a.description}>{a.description}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {error && (
            <p className={o.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      <Actions
        skip={list.length ? { label: "Skip for now", onClick: next, disabled: busy } : undefined}
        primary={
          list.length ? (
            <Button variant="primary" onClick={() => void save()} loading={busy} disabled={n === 0}>
              {n === 0 ? "Pick at least one" : n === 1 ? "Put 1 app on Home" : all ? `Put all ${n} on Home` : `Put ${n} on Home`}
            </Button>
          ) : (
            <Button variant="primary" onClick={next} disabled={!apps.data && !apps.error}>
              Continue
            </Button>
          )
        }
      />
    </>
  );
}
