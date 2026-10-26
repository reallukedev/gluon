import "server-only";
import type { User } from "../auth/users";
import type { AppSummary } from "../docker/apps";
import { detectServices, matchRecord, type Detected } from "../integrations/suggest";
import { statusFor, type IntegrationRecord } from "../integrations/store";
import { KINDS } from "../integrations/registry";
import { SIGN_IN_KINDS, type AppService, type InstalledApp } from "@/lib/widgets-types";
import type { LineState } from "@/lib/types";

const LINE_ORDER: Record<LineState, number> = {
  attention: 0,
  unhealthy: 0,
  running: 0,
  starting: 1,
  paused: 2,
  unknown: 2,
  stopped: 3,
};

/**
 * Installed apps as the widget catalog shows them: every app this person can see, each with the services
 * Gluon can read (and whether they're connected). `apps` must already be filtered to what the person may see.
 */
export function installedApps(user: Pick<User, "role">, apps: AppSummary[], records: IntegrationRecord[]): InstalledApp[] {
  const admin = user.role === "admin";
  const detected = detectServices(apps);
  // One service per app and kind (Octo offers Navidrome both directly and through Octo; the first found wins).
  const byApp = new Map<string, Detected[]>();
  for (const d of detected) {
    const list = byApp.get(d.app.id) ?? [];
    if (!list.some((x) => x.kind === d.kind)) list.push(d);
    byApp.set(d.app.id, list);
  }
  // The first running app per kind is its home (detection ranks Umbrel's own install above stray copies). Another
  // app offering only kinds that live elsewhere, and not connected itself, is a copy (e.g. CasaOS leftovers).
  const primary = new Map<string, string>();
  for (const d of detected) if (d.running && !primary.has(d.kind)) primary.set(d.kind, d.app.id);

  const out: InstalledApp[] = [];
  for (const app of apps) {
    if (app.self || app.hidden) continue;
    const found = byApp.get(app.id) ?? [];
    const duplicate = found.length > 0 && found.every((d) => primary.has(d.kind) && primary.get(d.kind) !== app.id && !matchRecord(d, records));
    const services: AppService[] = [];
    for (const d of found) {
      const rec = matchRecord(d, records);
      const usable = rec && (admin || rec.shared);
      if (!admin && !usable) continue;
      const status = rec ? statusFor(rec) : null;
      services.push({
        key: `${d.kind}:${app.id}`,
        kind: d.kind,
        label: d.name,
        line: d.container.line,
        widgets: KINDS[d.kind].widgets,
        state: !rec ? "none" : status?.ok === false ? "broken" : "connected",
        integrationId: usable ? rec.id : null,
        message: admin && status?.ok === false ? status.message : null,
        connect:
          admin && !duplicate
            ? {
                baseUrl: rec?.baseUrl ?? d.baseUrl,
                config: d.config,
                note: d.note,
                signIn: (SIGN_IN_KINDS as readonly string[]).includes(d.kind),
                keyHelp: KINDS[d.kind].keyHelp,
              }
            : null,
      });
    }
    out.push({
      appId: app.id,
      name: app.name,
      icon: app.icon,
      line: app.line,
      summary: app.summary,
      urls: app.urls,
      source: app.source,
      services: duplicate ? [] : services,
      duplicate,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.services.length > 0) - Number(a.services.length > 0) || LINE_ORDER[a.line] - LINE_ORDER[b.line] || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
