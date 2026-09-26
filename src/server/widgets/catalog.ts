import "server-only";
import type { User } from "../auth/users";
import { appsForMember, listApps, type AppSummary } from "../docker/apps";
import { listRecords, refOf, usableRecords, type IntegrationRecord } from "../integrations/store";
import { installedApps } from "./installed";
import { WIDGET_LABELS, WIDGET_REFRESH_MS, WIDGET_SOURCE, WIDGET_TYPES, type IntegrationRef, type WidgetCatalog } from "@/lib/widgets-types";

/** Integrations this person may use, with browser links and the state of the app they read from. */
export function refsFor(user: Pick<User, "role">, apps: AppSummary[]): IntegrationRef[] {
  const recs: IntegrationRecord[] = usableRecords(user);
  const byId = new Map(apps.map((a) => [a.id, a]));
  return recs.map((r) => {
    const app = r.appId ? byId.get(r.appId) : undefined;
    return refOf(r, { home: app?.urls.home ?? null, away: app?.urls.away ?? null }, app ? { id: app.id, line: app.line } : null);
  });
}

export async function integrationRefs(user: User): Promise<IntegrationRef[]> {
  return refsFor(user, await listApps().catch(() => []));
}

export async function widgetCatalog(user: User): Promise<WidgetCatalog> {
  // Everyone's connections read their app's state from the full list; the catalog only lists what this person may open.
  const all = await listApps().catch(() => [] as AppSummary[]);
  const visible = user.role === "admin" ? all : await appsForMember(user.id).catch(() => [] as AppSummary[]);
  const refs = refsFor(user, all);
  return {
    apps: installedApps(user, visible, user.role === "admin" ? listRecords() : usableRecords(user)),
    types: WIDGET_TYPES.map((type) => {
      const source = WIDGET_SOURCE[type];
      const integrations = source ? refs.filter((r) => r.kind === source) : [];
      return {
        type,
        label: WIDGET_LABELS[type].label,
        description: WIDGET_LABELS[type].description,
        source,
        refreshMs: WIDGET_REFRESH_MS[type],
        integrations,
        available: !source || integrations.length > 0,
      };
    }),
  };
}
