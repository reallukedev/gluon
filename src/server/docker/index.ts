import "server-only";
import { registerSearch, type ProviderGroup, type ProviderItem } from "../search";
import { listApps, appsForMember, type AppSummary } from "./apps";
import { matchScore, splitVerb } from "@/lib/search-match";
import type { SearchAction } from "@/lib/search-types";

const SOURCE: Record<AppSummary["source"], string> = { gluon: "Gluon", casaos: "CasaOS", umbrel: "Umbrel", compose: "Compose", docker: "Docker" };

function appKeywords(a: AppSummary): string {
  return [a.id, a.description ?? "", a.category ?? "", a.kind === "stack" ? "stack compose" : "container", ...a.containers.map((c) => `${c.name} ${c.service ?? ""} ${c.image.split(":")[0]}`)].join(" ");
}

const running = (a: AppSummary) => a.containers.some((c) => c.state === "running" || c.state === "restarting");

function post(a: AppSummary, action: "start" | "stop" | "restart"): SearchAction {
  const verb = { start: "Starting", stop: "Stopping", restart: "Restarting" }[action];
  return { url: `/api/apps/${encodeURIComponent(a.id)}/action`, body: { action }, pending: `${verb} ${a.name}…`, failed: `Couldn't ${action} ${a.name}` };
}

/** Words that ask for an app action, and the action they mean. */
const VERBS: Record<string, string> = { restart: "restart", reboot: "restart", stop: "stop", start: "start", open: "open", launch: "open", logs: "logs", log: "logs" };

/** What you can do to an app from the palette. Anything that interrupts people asks first. */
/** Actions that interrupt people: never the best match when it isn't clear which app was meant. */
const INTERRUPTS = new Set(["restart", "stop"]);
/** Below the palette's "best match" bar (0.75), so Enter can't pick one of two look-alikes. */
const AMBIGUOUS_CAP = 0.7;

/**
 * Actions for the apps that clearly match. When the query starts with a verb ("restart jelly") the
 * asked-for action of the one best app becomes the best match, so Enter does what was typed (Restart
 * and Stop still confirm). When two apps match about as well (the same app installed twice), none
 * of them is lifted: both sets of actions are listed, told apart by where each runs.
 */
export function actionsFor(strong: { a: AppSummary; score: number }[], zone: "home" | "away", verb: string | null): ProviderItem[] {
  if (!strong.length) return [];
  const twins = strong.length > 1 && strong[1]!.score >= strong[0]!.score - 0.02;
  const out: ProviderItem[] = [];
  strong.forEach(({ a, score }, i) => {
    for (const it of appActionList(a, score, zone, twins)) {
      const asked = !!verb && it.id.startsWith(`act:${verb}:`);
      if (!verb) out.push(it);
      else if (twins) out.push({ ...it, score: Math.min(it.score ?? 0, asked ? AMBIGUOUS_CAP : AMBIGUOUS_CAP - 0.05), final: true });
      else if (asked && i === 0) out.push({ ...it, score: 1, final: true });
      else out.push({ ...it, score: Math.min(it.score ?? 0, 0.74), final: true });
    }
  });
  return out;
}

function appActionList(a: AppSummary, score: number, zone: "home" | "away", twin = false): ProviderItem[] {
  const out: ProviderItem[] = [];
  // Two installs of the same app: say which one each action is for.
  const where = twin ? ` · ${SOURCE[a.source]}` : "";
  const url = zone === "away" ? (a.urls.away ?? a.urls.home) : (a.urls.home ?? a.urls.away);
  const s = (k: number) => Math.min(1, score) * k;
  if (url) out.push({ id: `act:open:${a.id}`, label: `Open ${a.name}`, hint: url.replace(/^https?:\/\//, "").replace(/\/$/, "") + where, icon: "open", image: a.icon, href: url, external: true, score: s(0.99) });
  const count = a.containers.length;
  if (running(a)) {
    out.push({
      id: `act:restart:${a.id}`,
      label: `Restart ${a.name}`,
      hint: (count > 1 ? `Stops and starts its ${count} containers` : "Stops it and starts it again") + where,
      icon: "restart",
      score: s(0.97),
      action: {
        ...post(a, "restart"),
        confirm: {
          title: `Restart ${a.name}?`,
          consequences: [`${a.name} is unavailable for a few seconds, and anyone using it right now is interrupted.`],
          confirmLabel: "Restart",
        },
      },
    });
    out.push({
      id: `act:stop:${a.id}`,
      label: `Stop ${a.name}`,
      hint: "Turns it off until someone starts it" + where,
      icon: "stop",
      score: s(0.9),
      action: {
        ...post(a, "stop"),
        confirm: {
          title: `Stop ${a.name}?`,
          consequences: [`${a.name} stays off until you start it again.`, "Anyone using it right now is disconnected."],
          confirmLabel: "Stop",
          danger: true,
        },
      },
    });
  } else if (count) {
    out.push({ id: `act:start:${a.id}`, label: `Start ${a.name}`, hint: (count > 1 ? `Starts its ${count} containers` : "Turns it on") + where, icon: "start", score: s(0.97), action: post(a, "start") });
  }
  out.push({ id: `act:logs:${a.id}`, label: `Show logs for ${a.name}`, hint: "Apps · logs" + where, icon: "logs", href: `/apps/${encodeURIComponent(a.id)}?tab=logs`, score: s(0.85) });
  return out;
}

registerSearch({
  key: "apps",
  name: "Apps",
  scope: "apps",
  priority: 10,
  minLength: 1,
  async run(user, _q, ctx) {
    const admin = user.role === "admin";
    const apps = admin ? await listApps() : await appsForMember(user.id);
    const { verb, rest } = splitVerb(ctx.query, VERBS);
    const scored = apps
      .filter((a) => !a.hidden || admin)
      .map((a) => {
        const fields = { label: a.name, keywords: admin ? appKeywords(a) : `${a.description ?? ""} ${a.category ?? ""}` };
        return { a, score: Math.max(matchScore(ctx.query, fields), verb ? matchScore(rest, fields) : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || Number(!!x.a.copyOf) - Number(!!y.a.copyOf));

    const items: ProviderItem[] = scored.slice(0, 8).map(({ a, score }) => {
      const url = ctx.zone === "away" ? (a.urls.away ?? a.urls.home) : (a.urls.home ?? a.urls.away);
      return admin
        ? {
            id: `app:${a.id}`,
            label: a.name,
            hint: `${a.summary} · ${a.kind === "stack" ? `${SOURCE[a.source]} stack, ${a.containers.length} container${a.containers.length === 1 ? "" : "s"}` : SOURCE[a.source]}`,
            icon: "app",
            image: a.icon,
            href: `/apps/${encodeURIComponent(a.id)}`,
            score,
          }
        : { id: `app:${a.id}`, label: a.name, hint: a.summary, icon: "app", image: a.icon, href: url ?? "/", external: !!url, score };
    });
    // "restart jelly" is about the action; the app itself stays in the list, below it.
    if (verb && admin) for (const it of items) Object.assign(it, { score: Math.min(it.score ?? 0, 0.74), final: true });
    const groups: ProviderGroup[] = [{ name: "Apps", items, priority: 10 }];

    if (admin) {
      // Containers whose own name matches, inside apps called something else ("immich_postgres").
      const shown = new Set(items.map((i) => i.id));
      const containers: ProviderItem[] = [];
      for (const a of apps) {
        for (const c of a.containers) {
          const score = matchScore(ctx.query, { label: c.name, keywords: `${c.service ?? ""} ${c.image}` });
          // A one-container app found by its own name already stands for its container.
          if (score < 0.5 || (shown.has(`app:${a.id}`) && a.containers.length === 1 && matchScore(ctx.query, { label: a.name }) >= score)) continue;
          containers.push({
            id: `container:${c.id}`,
            label: c.name,
            hint: `Container in ${a.name} · ${c.state === "running" ? (c.health === "unhealthy" ? "unhealthy" : "running") : c.state}`,
            icon: "container",
            href: `/apps/${encodeURIComponent(a.id)}?tab=logs&container=${encodeURIComponent(c.name)}`,
            score: score * 0.9,
          });
        }
      }
      containers.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
      if (containers.length) groups.push({ key: "containers", name: "Containers", items: containers.slice(0, 6), priority: 14 });

      // Commands for the apps that clearly match ("restart jelly", "jellyfin"). Older copies of an app
      // count when a verb asks for an action, so both installs can be acted on.
      const strong = scored.filter((x) => x.score >= 0.78 && (verb || !x.a.copyOf)).slice(0, verb ? 3 : 2);
      const actions = actionsFor(strong, ctx.zone, verb);
      if (actions.length) groups.push({ key: "app-actions", name: "Actions", items: actions, priority: 1 });
    }
    return groups;
  },
});
