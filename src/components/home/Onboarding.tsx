"use client";
import * as React from "react";
import { Check } from "iconoir-react";
import { usePrefs } from "@/components/PrefsProvider";
import { NavIcon } from "@/components/shell/NavIcon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { orderedNav } from "@/lib/nav";
import o from "./onboarding.module.css";

/**
 * First visit for a new account: Gluon starts with only Home, and this is where people add the
 * rest. Each choice goes straight into the real sidebar, so they see what they're building;
 * "Done" puts the welcome away. Settings → Sidebar & shortcuts changes it later.
 */
export function Onboarding() {
  const { prefs, viewer, setPrefs } = usePrefs();
  const [leaving, setLeaving] = React.useState(false);
  const all = orderedNav(viewer.role, [], [], { memberStatus: true, memberFiles: true }).all.filter((n) => n.id !== "home");
  const hidden = new Set(prefs.sidebarHidden);
  const chosen = all.filter((n) => !hidden.has(n.id));

  const toggle = (id: string) => {
    const next = hidden.has(id) ? prefs.sidebarHidden.filter((x) => x !== id) : [...prefs.sidebarHidden, id];
    void setPrefs({ sidebarHidden: next });
  };
  const everything = () => void setPrefs({ sidebarHidden: prefs.sidebarHidden.filter((x) => !all.some((n) => n.id === x)) });
  const finish = () => {
    setLeaving(true);
    window.setTimeout(() => {
      void setPrefs({ onboarding: "done" });
      toast.success(chosen.length ? `Your sidebar has Home and ${chosen.length === 1 ? chosen[0]!.label : `${chosen.length} more`}` : "Just Home, then", {
        description: "Change it any time in Settings → Sidebar & shortcuts.",
      });
    }, 200);
  };

  const admin = viewer.role === "admin";
  return (
    <section className={o.welcome} data-leaving={leaving ? "" : undefined} aria-labelledby="welcome-title">
      <div className={o.head}>
        <h2 id="welcome-title" className={o.title}>
          Gluon starts with just Home.
        </h2>
        <p className={o.lede}>
          {admin
            ? "Add the parts of the server you want to look after. Each one appears in the sidebar as you pick it."
            : "Add anything else you'd like in the sidebar. Each one appears as you pick it."}
        </p>
      </div>
      <ul className={o.choices} role="list">
        {all.map((n) => {
          const on = !hidden.has(n.id);
          return (
            <li key={n.id}>
              <button type="button" className={o.choice} aria-pressed={on} onClick={() => toggle(n.id)}>
                <span className={o.icon} aria-hidden>
                  <NavIcon id={n.id} />
                </span>
                <span className={o.text}>
                  <span className={o.label}>{n.label}</span>
                  <span className={o.hint}>{n.hint}</span>
                </span>
                <span className={o.tick} aria-hidden>
                  <Check strokeWidth={2.2} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={o.foot}>
        <span className={`${o.count} num`} aria-live="polite">
          {chosen.length ? `Home and ${chosen.length} more in your sidebar` : "Only Home in your sidebar"}
        </span>
        <div className={o.actions}>
          {chosen.length < all.length && (
            <Button variant="ghost" onClick={everything}>
              Add everything
            </Button>
          )}
          <Button variant="primary" onClick={finish}>
            {chosen.length ? "Done" : "Keep just Home"}
          </Button>
        </div>
      </div>
    </section>
  );
}
