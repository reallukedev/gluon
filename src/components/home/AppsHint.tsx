"use client";
import * as React from "react";
import { Xmark } from "iconoir-react";
import { useApi } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button, IconButton } from "@/components/ui/Button";
import type { WidgetItem } from "@/lib/home";
import type { WidgetCatalog } from "@/lib/widgets-types";
import { widgetDef } from "./registry";
import s from "./home.module.css";

const KEY = "gluon.home.appsHint";

/**
 * A quiet, dismissible line for admins: apps on this server that could show what they're doing on Home, but
 * have no widget here yet. It opens the catalog, where they lead.
 */
export function AppsHint({ items, onOpen }: { items: WidgetItem[]; onOpen: () => void }) {
  const [dismissed, setDismissed] = React.useState<string | null>("pending");
  React.useEffect(() => {
    try {
      setDismissed(localStorage.getItem(KEY));
    } catch {
      setDismissed(null);
    }
  }, []);
  const { data } = useApi<WidgetCatalog>(dismissed !== "pending" ? "/api/widgets/catalog" : null, { revalidateOnFocus: false });
  if (!data || dismissed === "pending") return null;
  const kindsOnPage = new Set(items.map((i) => widgetDef(i.type)?.kind).filter(Boolean));
  const appsOnPage = new Set(items.filter((i) => i.type === "app").map((i) => String(i.config.appId)));
  const waiting = data.apps.filter((a) => !a.duplicate && a.services.length && !appsOnPage.has(a.appId) && !a.services.some((sv) => kindsOnPage.has(sv.kind)));
  // Dismissal remembers which apps were offered; a newly installed app brings the line back.
  const signature = waiting
    .map((a) => a.appId)
    .sort()
    .join(",");
  if (!waiting.length || dismissed === signature) return null;
  const names = waiting.map((a) => a.name);
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return (
    <div className={s.appsHint} role="note">
      <span className={s.appsHintIcons} aria-hidden>
        {waiting.slice(0, 4).map((a) => (
          <AppIcon key={a.appId} src={a.icon} name={a.name} size={22} />
        ))}
      </span>
      <p>
        <b>{list}</b> can show what {names.length === 1 ? "it's" : "they're"} doing right here.
      </p>
      <Button size="sm" onClick={onOpen}>
        Add their widgets
      </Button>
      <IconButton
        label="Not now"
        size="sm"
        onClick={() => {
          setDismissed(signature);
          try {
            localStorage.setItem(KEY, signature);
          } catch {
            /* private mode: it just comes back next time */
          }
        }}
      >
        <Xmark />
      </IconButton>
    </div>
  );
}
