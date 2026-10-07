"use client";
import * as React from "react";
import { Lock, LockSlash, Cloud, CloudSync, Internet, HomeSimpleDoor, Server, Search } from "iconoir-react";
import type { AppSummary } from "@/server/docker/apps";
import type { ExposureReport, RouteT, RoutesConfigT, RoutesResponse, SubdomainRouteT, RedirectRouteT } from "@/lib/network-types";
import { api, ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, TextArea, AffixInput, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import type { Commit } from "./NetworkView";
import { suggestLabel, newRouteId, bare, tcpPorts, isRedirectRoute, THIS_SERVER } from "./shared";
import f from "./flow.module.css";

/**
 * "Put an app on the internet": pick the app → choose its address (live preview, whether the name is
 * free, direct or through Cloudflare) → protection (does it have a login; publish all of it or only
 * some paths) → review where it will sit on the map → save. Editing an address reuses the same steps,
 * opened on the review. Redirects and the "everything else" app use a shorter version.
 */

export type FlowTarget = { mode: "new"; appId?: string } | { mode: "edit"; id: string } | { mode: "redirect"; id?: string } | { mode: "fallback" };

type Step = "app" | "address" | "protection" | "review";
const STEP_NAME: Record<Step, string> = { app: "App", address: "Address", protection: "Protection", review: "Review" };

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PATH_RE = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;
const MATCH_RE = /^\/[A-Za-z0-9._~/-]*\*?$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/;

interface Form {
  appId: string | null;
  other: boolean;
  port: string;
  lane: "direct" | "cloudflare";
  label: string;
  customHost: boolean;
  path: string;
  name: string;
  shortLink: boolean;
  shortPath: string;
  scope: "all" | "some";
  onlyPaths: string;
  backendHost: string;
  tls: boolean;
  stripPrefix: boolean;
  note: string;
  enabled: boolean;
  ack: boolean;
  target: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const cleanPath = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

function blank(): Form {
  return {
    appId: null,
    other: false,
    port: "",
    lane: "direct",
    label: "",
    customHost: false,
    path: "",
    name: "",
    shortLink: false,
    shortPath: "",
    scope: "all",
    onlyPaths: "",
    backendHost: THIS_SERVER,
    tls: false,
    stripPrefix: false,
    note: "",
    enabled: true,
    ack: false,
    target: "",
  };
}

/** Redirects that lead to this subdomain (its short links). */
function linksTo(routes: RouteT[], host: string): RedirectRouteT[] {
  return routes.filter((r): r is RedirectRouteT => r.type === "redirect" && hostOf(r.target) === host.toLowerCase());
}

function fromRoute(r: RouteT, cfg: RoutesConfigT, knownApp: string | null): Form {
  const base = cfg.base_domain;
  const f = blank();
  f.name = r.name;
  f.note = r.note ?? "";
  f.enabled = r.enabled !== false;
  f.appId = r.app ?? knownApp;
  f.other = !(r.app ?? knownApp);
  if (r.type === "redirect") {
    f.lane = "cloudflare";
    f.path = r.path.replace(/^\//, "");
    f.target = r.target;
    return f;
  }
  f.port = String(r.backend.port);
  f.backendHost = r.backend.host;
  f.tls = r.backend.tls;
  if (r.type === "subdomain") {
    const underBase = r.host.endsWith(`.${base}`) && !r.host.slice(0, -base.length - 1).includes(".");
    f.lane = "direct";
    f.label = underBase ? r.host.slice(0, -base.length - 1) : r.host;
    f.customHost = !underBase;
    f.scope = r.only_paths?.length ? "some" : "all";
    f.onlyPaths = (r.only_paths ?? []).join(" ");
    const link = linksTo(cfg.routes, r.host)[0];
    if (link) {
      f.shortLink = true;
      f.shortPath = link.path.replace(/^\//, "");
    }
  } else {
    f.lane = "cloudflare";
    f.path = r.path.replace(/^\//, "");
    f.stripPrefix = r.strip_prefix;
  }
  return f;
}

interface Props {
  target: FlowTarget;
  data: RoutesResponse;
  apps: AppSummary[] | undefined;
  exposure: ExposureReport | undefined;
  publicIp: string | null;
  commit: Commit;
  onClose: () => void;
  onReload: () => void;
  onEditInstead: (routeId: string) => void;
  onLoginChanged: () => void;
}

export function PublishFlow({ target, data, apps, exposure, publicIp, commit, onClose, onReload, onEditInstead, onLoginChanged }: Props) {
  const cfg = data.config;
  const base = cfg.base_domain;
  const existing = target.mode === "edit" || (target.mode === "redirect" && target.id) ? cfg.routes.find((r) => r.id === (target as { id: string }).id) : undefined;
  const mode: "app" | "redirect" | "fallback" = target.mode === "fallback" ? "fallback" : target.mode === "redirect" || existing?.type === "redirect" ? "redirect" : "app";
  const steps: Step[] = mode === "fallback" ? ["app", "review"] : mode === "redirect" ? ["address", "review"] : ["app", "address", "protection", "review"];

  const [open, setOpenState] = React.useState(true);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setTimeout(onClose, 250);
  };
  const [form, setForm] = React.useState<Form>(() => {
    if (existing) return fromRoute(existing, cfg, data.apps[existing.id]?.appId ?? null);
    if (mode === "fallback") {
      const b = blank();
      b.appId = cfg.fallback.app ?? data.apps.__fallback__?.appId ?? null;
      b.other = !b.appId;
      b.port = String(cfg.fallback.backend.port);
      b.backendHost = cfg.fallback.backend.host;
      b.tls = cfg.fallback.backend.tls;
      b.name = cfg.fallback.name;
      return b;
    }
    const b = blank();
    if (mode === "redirect") b.lane = "cloudflare";
    return b;
  });
  // Editing opens on the review with every step reachable; adding walks forward.
  const [step, setStep] = React.useState<Step>(existing || mode === "fallback" ? steps[steps.length - 1]! : steps[0]!);
  const [touched, setTouched] = React.useState({ name: !!existing, label: !!existing, path: !!existing, shortPath: !!existing });
  const [more, setMore] = React.useState(() => !!existing && existing.type !== "redirect" && (existing.backend.host !== THIS_SERVER || existing.backend.tls || !!existing.note));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [loginOverride, setLoginOverride] = React.useState<"yes" | "no" | null>(null);
  const [marking, setMarking] = React.useState(false);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((x) => ({ ...x, [k]: v }));
    setErrors((e) => {
      if (!(k in e)) return e;
      const { [k]: _, ...rest } = e;
      void _;
      return rest;
    });
  };

  const pickable = React.useMemo(
    () => (apps ?? []).filter((a) => tcpPorts(a).length > 0).sort((a, b) => Number(a.line === "stopped") - Number(b.line === "stopped") || a.name.localeCompare(b.name)),
    [apps],
  );
  const shown = filter.trim() ? pickable.filter((a) => a.name.toLowerCase().includes(filter.trim().toLowerCase())) : pickable;
  const app = form.appId ? (apps ?? []).find((a) => a.id === form.appId) : undefined;
  // The address names an app Gluon can't find (renamed or removed): let the port be edited directly.
  const manualPort = form.other || (!!form.appId && !!apps && !app);

  const choose = React.useCallback(
    (a: AppSummary) => {
      const ports = tcpPorts(a);
      setForm((x) => ({
        ...x,
        appId: a.id,
        other: false,
        port: String(a.webPort ?? ports[0] ?? ""),
        backendHost: THIS_SERVER,
        tls: false,
        name: touched.name && x.name ? x.name : a.name,
        label: touched.label && x.label ? x.label : suggestLabel(a.name),
        path: touched.path && x.path ? x.path : suggestLabel(a.name),
        shortPath: touched.shortPath && x.shortPath ? x.shortPath : suggestLabel(a.name),
        ack: false,
      }));
      setLoginOverride(null);
      setErrors({});
    },
    [touched],
  );

  // ?publish=<app>: pick it once the app list arrives, then go straight to the address.
  const preselected = React.useRef(false);
  React.useEffect(() => {
    if (preselected.current || target.mode !== "new" || !target.appId || !apps) return;
    preselected.current = true;
    const a = apps.find((x) => x.id === target.appId);
    if (a) {
      choose(a);
      setStep("address");
    }
  }, [apps, target, choose]);

  // ---- derived
  const port = Number(form.port);
  const direct = mode === "app" && form.lane === "direct";
  const host = direct ? (form.customHost ? form.label.trim().toLowerCase() : `${form.label.trim().toLowerCase()}.${base}`) : base;
  const pathPart = direct ? "" : `/${cleanPath(form.path)}`;
  const url = mode === "fallback" ? `https://${base}` : `https://${host}${pathPart}`;
  const appName =
    mode === "redirect"
      ? null
      : (app?.name ??
        (form.other ? null : mode === "fallback" && form.appId === (cfg.fallback.app ?? data.apps.__fallback__?.appId) ? (data.apps.__fallback__?.name ?? cfg.fallback.name) : form.appId));
  const localBackend = form.backendHost === THIS_SERVER || form.backendHost === "localhost";
  const onlyPaths = form.onlyPaths.split(/[\s,]+/).filter(Boolean);
  const ownLinks = existing?.type === "subdomain" ? linksTo(cfg.routes, existing.host) : [];

  const takenHost = direct ? cfg.routes.find((r) => r.type === "subdomain" && r.id !== existing?.id && r.host === host) : undefined;
  const takenPath = (p: string, skip: Set<string>) => cfg.routes.find((r) => r.type !== "subdomain" && !skip.has(r.id) && r.path.toLowerCase() === `/${p}`.toLowerCase());
  const pathSkip = new Set([existing?.id].filter(Boolean) as string[]);
  const linkSkip = new Set([ownLinks[0]?.id].filter(Boolean) as string[]);
  const nameOf = (r: RouteT) => data.apps[r.id]?.name ?? r.name;

  // Is the address free? One live line under the name.
  const availability: { state: "running" | "unhealthy"; text: string } | null = (() => {
    if (mode === "redirect" || mode === "fallback") {
      if (mode === "fallback") return null;
      const p = cleanPath(form.path);
      if (!p) return null;
      if (!PATH_RE.test(p)) return { state: "unhealthy", text: "Use letters, numbers and . _ ~ - (e.g. photos)." };
      const t = takenPath(p, pathSkip);
      return t ? { state: "unhealthy", text: `Already used by ${nameOf(t)}.` } : { state: "running", text: "Free." };
    }
    if (direct) {
      const l = form.label.trim().toLowerCase();
      if (!l) return null;
      if (form.customHost ? !HOST_RE.test(l) : !LABEL_RE.test(l)) return { state: "unhealthy", text: form.customHost ? "Enter a full name, like photos.example.com." : "Use letters, numbers and dashes; it can't start or end with a dash." };
      if (form.customHost && (l === base || l.endsWith(`.${base}`))) return { state: "unhealthy", text: `Use the box without “more options” for names under ${base}.` };
      if (takenHost) return { state: "unhealthy", text: `Already used by ${nameOf(takenHost)}.` };
      return { state: "running", text: form.customHost ? `Free. It needs its own DNS record pointing to ${publicIp ?? "your internet address"}.` : "Free. The wildcard DNS record already covers it, so there's nothing to set up in Cloudflare." };
    }
    const p = cleanPath(form.path);
    if (!p) return null;
    if (!PATH_RE.test(p)) return { state: "unhealthy", text: "Use letters, numbers and . _ ~ - (e.g. photos)." };
    const t = takenPath(p, new Set([...pathSkip, ...linkSkip]));
    return t ? { state: "unhealthy", text: `Already used by ${nameOf(t)}.` } : { state: "running", text: "Free." };
  })();

  // Does it have a login? The admin's setting first, then Gluon's own look at the page.
  const lan = exposure?.lan.find((l) => l.proto === "tcp" && l.port === port);
  const routeExp = existing ? exposure?.internet.find((x) => x.routeId === existing.id) : undefined;
  const declared = loginOverride ?? (app?.hasLogin !== "unknown" ? app?.hasLogin : undefined);
  const probe = routeExp?.login.probe ?? (lan?.login?.probe as "login" | "none" | "unknown" | null | undefined) ?? null;
  const loginVerdict: "login" | "none" | "unknown" = declared === "yes" ? "login" : declared === "no" ? "none" : probe === "login" ? "login" : probe === "none" ? "none" : "unknown";
  const loginEvidence = declared === "yes" ? "Marked as having its own login." : declared === "no" ? "Marked as having no login of its own." : (routeExp?.login.evidence ?? lan?.login?.evidence ?? null);
  const checkingLogin = !exposure && !declared;
  const exposed = mode === "app" && localBackend && port > 0 && !(direct && form.scope === "some");
  const noLogin = exposed && loginVerdict === "none";
  const already = mode === "app" && !existing && app ? cfg.routes.find((r) => !isRedirectRoute(r) && (r.app === app.id || data.apps[r.id]?.appId === app.id)) : undefined;

  async function markLogin(v: "yes" | "no") {
    if (!app) return;
    setMarking(true);
    try {
      await api.patch(`/api/apps/${encodeURIComponent(app.id)}/prefs`, { hasLogin: v });
      setLoginOverride(v);
      onLoginChanged();
      toast.success(v === "yes" ? `Noted: ${app.name} has its own login` : `Noted: ${app.name} has no login`);
    } catch (e) {
      toast.error("Couldn't save that", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setMarking(false);
    }
  }

  function check(s: Step): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === "app") {
      if (manualPort) {
        if (!(port >= 1 && port <= 65535)) e.port = "Enter the port the app listens on (1–65535).";
        if (mode === "fallback" && !form.name.trim()) e.name = "Give it a name, e.g. Dashboard.";
      } else if (!form.appId) e.app = "Pick the app to put on the internet.";
    }
    if (s === "address") {
      if (mode === "redirect") {
        if (!form.name.trim()) e.name = "Give the short link a name.";
        if (!cleanPath(form.path)) e.path = "Choose the path, e.g. photos.";
        else if (availability?.state === "unhealthy") e.path = availability.text;
        if (!URL_RE.test(form.target.trim())) e.target = "Enter a full address starting with https://";
      } else {
        if (!form.name.trim()) e.name = "Give the address a name, e.g. Photos.";
        if (direct && !form.label.trim()) e.label = "Choose the name people will type.";
        else if (!direct && !cleanPath(form.path)) e.label = "Choose the path, e.g. photos.";
        else if (availability?.state === "unhealthy") e.label = availability.text;
        if (direct && form.shortLink) {
          const p = cleanPath(form.shortPath);
          if (!p || !PATH_RE.test(p)) e.shortPath = "Use letters, numbers and . _ ~ - (e.g. photos).";
          else {
            const t = takenPath(p, linkSkip);
            if (t && t.id !== existing?.id) e.shortPath = `Already used by ${nameOf(t)}.`;
          }
        }
        if (!(form.backendHost.trim() && /^[A-Za-z0-9.-]+$/.test(form.backendHost.trim()))) e.backendHost = "Enter a host name or IP address.";
      }
    }
    if (s === "protection") {
      if (direct && form.scope === "some") {
        if (!onlyPaths.length) e.onlyPaths = "List at least one path, e.g. /rest/*";
        else {
          const bad = onlyPaths.find((p) => !MATCH_RE.test(p));
          if (bad) e.onlyPaths = `“${bad}” isn't a path pattern. Use e.g. /rest/* or /api/health.`;
        }
      }
      if (noLogin && !form.ack) e.ack = "Tick the box to publish it without a login, or publish only some paths.";
    }
    return e;
  }

  const idx = steps.indexOf(step);
  function go(to: Step) {
    const i = steps.indexOf(to);
    if (i > idx) {
      // Validate every step up to the target.
      for (const s of steps.slice(0, i)) {
        const e = check(s);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(s);
          return;
        }
      }
    }
    setErrors({});
    setStep(to);
  }

  function build(): { routes: RouteT[]; fallback?: RoutesConfigT["fallback"] } {
    const routes = cfg.routes;
    if (mode === "fallback") {
      const name = (form.other ? form.name.trim() : app?.name) || cfg.fallback.name;
      return { routes, fallback: { name, app: form.other ? null : (form.appId ?? null), backend: { host: form.backendHost.trim() || THIS_SERVER, port, tls: form.tls } } };
    }
    const common = {
      name: form.name.trim(),
      enabled: form.enabled,
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    };
    if (mode === "redirect") {
      const id = existing?.id ?? newRouteId(form.name || form.path);
      const r: RouteT = { id, type: "redirect", ...common, ...(existing?.app ? { app: existing.app } : {}), path: `/${cleanPath(form.path)}`, target: form.target.trim() };
      return { routes: existing ? routes.map((x) => (x.id === id ? r : x)) : [...routes, r] };
    }
    const id = existing?.id ?? newRouteId(form.name || form.label || form.path);
    const appRef = form.appId && !form.other ? { app: form.appId } : existing?.app && !form.other ? { app: existing.app } : {};
    const backend = { host: form.backendHost.trim() || THIS_SERVER, port, tls: form.tls };
    let route: RouteT;
    if (direct) {
      // Extra paths have no editor; carry them through untouched instead of dropping them.
      const extra = existing?.type === "subdomain" && existing.extra_paths?.length ? { extra_paths: existing.extra_paths } : {};
      route = { id, type: "subdomain", ...common, ...appRef, host, backend, ...(form.scope === "some" && onlyPaths.length ? { only_paths: onlyPaths } : {}), ...extra } as SubdomainRouteT;
    } else {
      route = { id, type: "path", ...common, ...appRef, path: pathPart, backend, strip_prefix: form.stripPrefix };
    }
    let next = existing ? routes.map((x) => (x.id === id ? route : x)) : [...routes, route];
    const oldHost = existing?.type === "subdomain" ? existing.host : null;
    const newTarget = `https://${host}`;
    if (direct) {
      // Short links follow a renamed address.
      if (oldHost && oldHost !== host) next = next.map((x) => (x.type === "redirect" && hostOf(x.target) === oldHost ? { ...x, target: newTarget } : x));
      const mine = ownLinks[0];
      if (form.shortLink) {
        const link: RedirectRouteT = {
          id: mine?.id ?? newRouteId(`${form.name || form.label}-link`),
          type: "redirect",
          name: form.name.trim(),
          enabled: form.enabled,
          ...(form.appId && !form.other ? { app: form.appId } : mine?.app ? { app: mine.app } : {}),
          ...(mine?.note ? { note: mine.note } : {}),
          path: `/${cleanPath(form.shortPath)}`,
          target: newTarget,
        };
        next = mine ? next.map((x) => (x.id === mine.id ? link : x)) : [...next, link];
      } else if (mine) next = next.filter((x) => x.id !== mine.id);
    } else if (oldHost) {
      // Moved from a subdomain to a path: its short links would lead nowhere.
      next = next.filter((x) => !(x.type === "redirect" && hostOf(x.target) === oldHost));
    }
    return { routes: next };
  }

  async function save() {
    setGeneral(null);
    for (const s of steps) {
      const e = check(s);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(s);
        return;
      }
    }
    const { routes, fallback } = build();
    setSaving(true);
    try {
      const where = bare(url);
      await commit(routes, {
        fallback,
        success:
          mode === "fallback"
            ? `${fallback?.name ?? "It"} now answers ${where}.`
            : existing
              ? `Saved ${where}.`
              : `${where} is on the internet. Its certificate arrives within a minute.`,
      });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") setStale(true);
      else if (e instanceof ApiError && e.field) {
        const map: Record<string, [string, Step]> = {
          backend_host: ["backendHost", "address"],
          only_paths: ["onlyPaths", "protection"],
          host: ["label", "address"],
          path: [mode === "redirect" ? "path" : "label", "address"],
          target: ["target", "address"],
          name: ["name", "address"],
          port: ["port", "app"],
        };
        const [key, at] = map[e.field] ?? [e.field, step];
        if (key === "backendHost") setMore(true);
        setErrors({ [key]: e.message });
        setStep(steps.includes(at) ? at : step);
      } else setGeneral(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  }

  const title =
    mode === "fallback" ? "What answers everything else" : mode === "redirect" ? (existing ? `Edit ${existing.name}` : "Add a short link") : existing ? `Edit ${existing.name}` : "Put an app on the internet";
  const description =
    mode === "fallback"
      ? `The app that answers ${base} and any path no other address claims.`
      : mode === "redirect"
        ? `A path on ${base} that sends visitors to another address.`
        : existing
          ? bare(data.urls[existing.id] ?? url)
          : "Pick an app, give it an address, and Gluon sets up the rest.";
  const last = idx === steps.length - 1;
  const primaryLabel = last ? (mode === "fallback" ? "Save" : existing ? "Save changes" : mode === "redirect" ? "Add the short link" : "Put it on the internet") : "Continue";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && setOpen(o)}
      title={title}
      description={description}
      size="wide"
      footer={
        <>
          {idx > 0 ? (
            <Button variant="ghost" onClick={() => go(steps[idx - 1]!)} disabled={saving}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button variant="primary" loading={saving} onClick={() => (last ? void save() : go(steps[idx + 1]!))}>
            {primaryLabel}
          </Button>
        </>
      }
    >
      <form
        className={f.flow}
        onSubmit={(e) => {
          e.preventDefault();
          if (last) void save();
          else go(steps[idx + 1]!);
        }}
      >
        {steps.length > 2 && <FlowSteps label="Steps" steps={steps.map((k) => ({ key: k, label: STEP_NAME[k] }))} current={step} working={saving} />}

        {stale && (
          <Notice
            tone="attention"
            title="The addresses changed somewhere else"
            action={
              <Button
                size="sm"
                onClick={() => {
                  onReload();
                  setStale(false);
                }}
              >
                Reload
              </Button>
            }
          >
            Reload the latest list, then save again. What you entered here is kept.
          </Notice>
        )}
        {general && <Notice tone="fault" title="That didn't save">{general}</Notice>}

        <div className={f.stage}>
        <div className={`${f.body} appear`} key={step}>
          {step === "app" && (
            <div className={f.section}>
              <div className={f.pickHead}>
                <p className={f.q}>{mode === "fallback" ? `Which app answers ${base}?` : "Which app should people reach?"}</p>
                {pickable.length > 9 && (
                  <div className={f.filter}>
                    <Search aria-hidden />
                    <Input aria-label="Find an app" placeholder="Find an app" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  </div>
                )}
              </div>
              {!apps ? (
                <div className={f.picker}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} height={64} radius={8} />
                  ))}
                </div>
              ) : (
                <div className={f.picker} role="radiogroup" aria-label="App">
                  {shown.map((a) => {
                    const ports = tcpPorts(a);
                    const on = form.appId === a.id && !form.other;
                    return (
                      <button key={a.id} type="button" role="radio" aria-checked={on} className={f.pick} data-on={on ? "" : undefined} onClick={() => choose(a)} title={a.name}>
                        <AppIcon src={a.icon} name={a.name} size={30} />
                        <span className={f.pickText}>
                          <span className={f.pickName}>{a.name}</span>
                          <span className={`${f.pickSub} mono`}>
                            {a.line === "stopped" ? "stopped · " : ""}:{ports[0]}
                            {ports.length > 1 ? ` +${ports.length - 1}` : ""}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.other}
                    className={f.pick}
                    data-on={form.other ? "" : undefined}
                    onClick={() => {
                      setForm((x) => ({ ...x, other: true, appId: null }));
                      setErrors({});
                    }}
                  >
                    <span className={f.pickOther} aria-hidden>
                      :
                    </span>
                    <span className={f.pickText}>
                      <span className={f.pickName}>Something else</span>
                      <span className={f.pickSub}>Enter a port</span>
                    </span>
                  </button>
                  {shown.length === 0 && filter && <p className={f.faint}>No app matches “{filter}”.</p>}
                </div>
              )}
              {errors.app && <p className={f.error}>{errors.app}</p>}
              {app && !form.other && tcpPorts(app).length > 1 && (
                <Field label="Its web page is on port" description={`${app.name} publishes more than one port. Pick the one its web page uses.`}>
                  <Select aria-label="Port" value={form.port} onChange={(v) => set("port", v)} options={tcpPorts(app).map((p) => ({ value: String(p), label: `Port ${p}${p === app.webPort ? " (web page)" : ""}` }))} />
                </Field>
              )}
              {manualPort && (
                <div className={f.row2}>
                  <Field label="Port on this server" error={errors.port} description="The port the app listens on.">
                    <Input value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono placeholder="8080" />
                  </Field>
                  {mode === "fallback" && (
                    <Field label="Name" error={errors.name}>
                      <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={60} placeholder="Dashboard" />
                    </Field>
                  )}
                </div>
              )}
              {already && (
                <Notice
                  title={`${app!.name} is already on the internet`}
                  action={
                    <Button size="sm" onClick={() => onEditInstead(already.id)}>
                      Edit that address
                    </Button>
                  }
                >
                  It&rsquo;s at {bare(data.urls[already.id] ?? "")}. Continue to give it a second address.
                </Notice>
              )}
            </div>
          )}

          {step === "address" && mode === "redirect" && (
            <div className={f.section}>
              <p className={f.q}>Where does the short link live, and where does it send people?</p>
              <Field label="Path" error={errors.path}>
                <AffixInput before={`${base}/`} value={form.path} onChange={(e) => (setTouched((t) => ({ ...t, path: true })), set("path", e.target.value.replace(/[^A-Za-z0-9._~/-]/g, "")))} mono placeholder="photos" spellCheck={false} autoCapitalize="off" />
              </Field>
              {availability && !errors.path && <Availability a={availability} />}
              <Field label="Sends visitors to" error={errors.target} description={`Anything after the path is kept: ${base}/${cleanPath(form.path) || "photos"}/a leads to that address/a.`}>
                <Input value={form.target} onChange={(e) => set("target", e.target.value)} mono placeholder="https://photos.example.com" spellCheck={false} autoCapitalize="off" />
              </Field>
              <Field label="Name" error={errors.name} description="Shown in Gluon.">
                <Input value={form.name} onChange={(e) => (setTouched((t) => ({ ...t, name: true })), set("name", e.target.value))} maxLength={60} placeholder="Photos" />
              </Field>
            </div>
          )}

          {step === "address" && mode === "app" && (
            <div className={f.section}>
              {already && (
                <Notice
                  title={`${app!.name} is already on the internet`}
                  action={
                    <Button size="sm" onClick={() => onEditInstead(already.id)}>
                      Edit that address
                    </Button>
                  }
                >
                  It&rsquo;s at {bare(data.urls[already.id] ?? "")}. Continue to give it a second address.
                </Notice>
              )}
              <p className={f.q}>How should people connect?</p>
              <div className={f.lanes} role="radiogroup" aria-label="How people connect">
                <LaneChoice
                  on={form.lane === "direct"}
                  onPick={() => set("lane", "direct")}
                  icon={<Cloud />}
                  title="Direct"
                  example={`${form.label || "name"}.${base}`}
                  text="Straight to your home. No size limits, so video and big uploads work. Recommended."
                />
                <LaneChoice
                  on={form.lane === "cloudflare"}
                  onPick={() => set("lane", "cloudflare")}
                  icon={<CloudSync />}
                  title="Through Cloudflare"
                  example={`${base}/${cleanPath(form.path) || "name"}`}
                  text="Hides your home's address. Uploads over 100 MB fail, no video, and the app must support living under a path."
                />
              </div>

              <div className={f.nameBlock}>
                {direct ? (
                  <Field label="Address" error={errors.label}>
                    {form.customHost ? (
                      <AffixInput before="https://" value={form.label} onChange={(e) => (setTouched((t) => ({ ...t, label: true })), set("label", e.target.value.trim().toLowerCase()))} mono placeholder="photos.example.com" spellCheck={false} autoCapitalize="off" />
                    ) : (
                      <AffixInput before="https://" after={`.${base}`} value={form.label} onChange={(e) => (setTouched((t) => ({ ...t, label: true })), set("label", e.target.value.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()))} mono placeholder="photos" spellCheck={false} autoCapitalize="off" />
                    )}
                  </Field>
                ) : (
                  <Field label="Address" error={errors.label}>
                    <AffixInput before={`https://${base}/`} value={form.path} onChange={(e) => (setTouched((t) => ({ ...t, path: true })), set("path", e.target.value.replace(/[^A-Za-z0-9._~/-]/g, "")))} mono placeholder="photos" spellCheck={false} autoCapitalize="off" />
                  </Field>
                )}
                <div className={f.preview} aria-live="polite">
                  <span className={f.previewUrl}>
                    <span className={f.dim}>https://</span>
                    {direct ? (
                      form.customHost ? (
                        <span>{form.label || "…"}</span>
                      ) : (
                        <>
                          <span>{form.label || "…"}</span>
                          <span className={f.dim}>.{base}</span>
                        </>
                      )
                    ) : (
                      <>
                        <span className={f.dim}>{base}/</span>
                        <span>{cleanPath(form.path) || "…"}</span>
                      </>
                    )}
                  </span>
                  {availability && !errors.label ? <Availability a={availability} /> : <span className={f.faint}>Type a name to see if it&rsquo;s free.</span>}
                </div>
              </div>

              {direct && (
                <div className={f.shortLink}>
                  <Checkbox checked={form.shortLink} onChange={(v) => set("shortLink", v)}>
                    Also add a short link on {base}
                    <span className={f.hint}>
                      <span className="mono">
                        {base}/{cleanPath(form.shortPath) || "name"}
                      </span>{" "}
                      sends people to the address above. Handy to remember; the app itself still goes direct.
                    </span>
                  </Checkbox>
                  {form.shortLink && (
                    <Field label="Short link path" error={errors.shortPath}>
                      <AffixInput before={`${base}/`} value={form.shortPath} onChange={(e) => (setTouched((t) => ({ ...t, shortPath: true })), set("shortPath", e.target.value.replace(/[^A-Za-z0-9._~/-]/g, "")))} mono placeholder="photos" spellCheck={false} autoCapitalize="off" />
                    </Field>
                  )}
                </div>
              )}

              <Disclosure summary="More options" open={more} onOpenChange={setMore}>
                <div className={f.more}>
                  <Field label="Name in Gluon" error={errors.name} description="Also written as a comment in the Caddyfile.">
                    <Input value={form.name} onChange={(e) => (setTouched((t) => ({ ...t, name: true })), set("name", e.target.value))} maxLength={60} placeholder="Photos" />
                  </Field>
                  {direct && (
                    <Checkbox checked={form.customHost} onChange={(v) => set("customHost", v)}>
                      Use a name outside {base}
                      <span className={f.hint}>It needs its own DNS record pointing at your router before a certificate can be issued.</span>
                    </Checkbox>
                  )}
                  {!direct && (
                    <Checkbox checked={form.stripPrefix} onChange={(v) => set("stripPrefix", v)}>
                      Remove /{cleanPath(form.path) || "name"} before passing visits on
                      <span className={f.hint}>For apps without a base-URL setting. Only works if the app uses relative links; otherwise set its base URL to /{cleanPath(form.path) || "name"} and leave this off.</span>
                    </Checkbox>
                  )}
                  <div className={f.row2}>
                    <Field label="Server" error={errors.backendHost} description="host.docker.internal is this server, as the web server sees it.">
                      <Input value={form.backendHost} onChange={(e) => set("backendHost", e.target.value.trim())} mono spellCheck={false} autoCapitalize="off" />
                    </Field>
                    <Field label="Port" error={manualPort ? undefined : errors.port}>
                      <Input value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono />
                    </Field>
                  </div>
                  <Checkbox checked={form.tls} onChange={(v) => set("tls", v)}>
                    The app itself speaks HTTPS
                    <span className={f.hint}>The web server connects to it over HTTPS and accepts its self-signed certificate.</span>
                  </Checkbox>
                  <Field label="Note" optional description="Why this exists, for future you.">
                    <TextArea value={form.note} onChange={(e) => set("note", e.target.value)} rows={2} maxLength={400} />
                  </Field>
                </div>
              </Disclosure>
            </div>
          )}

          {step === "protection" && (
            <div className={f.section}>
              <p className={f.q}>Who can use {appName ?? "it"} once it&rsquo;s on the internet?</p>
              <div className={f.loginCard} data-tone={checkingLogin ? "checking" : loginVerdict}>
                <span className={f.loginIcon} aria-hidden>
                  {loginVerdict === "none" ? <LockSlash /> : <Lock />}
                </span>
                <div className={f.loginText}>
                  <p className={f.loginTitle}>
                    {checkingLogin
                      ? `Checking whether ${appName ?? "it"} has a login…`
                      : loginVerdict === "login"
                        ? `${appName ?? "It"} asks for a login`
                        : loginVerdict === "none"
                          ? `${appName ?? "It"} has no login of its own`
                          : `Gluon can't tell whether ${appName ?? "it"} has a login`}
                  </p>
                  {loginEvidence && <p className={f.faint}>{loginEvidence}</p>}
                  {app && !checkingLogin && (
                    <p className={f.loginFix}>
                      {loginVerdict !== "login" && (
                        <Button size="sm" loading={marking} onClick={() => void markLogin("yes")}>
                          It has its own login
                        </Button>
                      )}
                      {loginVerdict !== "none" && (
                        <>
                          {loginVerdict === "login" && <span className={f.faint}>Not right?</span>}
                          <Button size="sm" variant={loginVerdict === "login" ? "ghost" : "secondary"} loading={marking} onClick={() => void markLogin("no")}>
                            It has no login
                          </Button>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {direct ? (
                <div className={f.scope} role="radiogroup" aria-label="What to publish">
                  <ScopeChoice on={form.scope === "all"} onPick={() => set("scope", "all")} title="The whole app" text={`Everything ${appName ?? "the app"} serves is reachable, and its own login protects it.`} />
                  <ScopeChoice on={form.scope === "some"} onPick={() => set("scope", "some")} title="Only some paths" text="Only the paths you list are reachable; everything else answers “not found”. Useful to keep an admin page home-only." />
                </div>
              ) : (
                <p className={f.faint}>Addresses through Cloudflare publish the whole app.</p>
              )}
              {direct && form.scope === "some" && (
                <Field label="Paths to publish" error={errors.onlyPaths} description="Separate with spaces. A * at the end covers everything under it, e.g. /rest/* /api/health">
                  <Input value={form.onlyPaths} onChange={(e) => set("onlyPaths", e.target.value)} mono placeholder="/rest/*" spellCheck={false} autoCapitalize="off" />
                </Field>
              )}
              {noLogin && (
                <Notice tone="attention" title="Anyone who finds the address could use it">
                  <p>
                    {bare(url)} would open {appName ?? "the app"} for anyone on the internet, with nothing asking who they are. Give the app a password first, or publish only the paths it needs.
                  </p>
                  <div className={f.ack}>
                    <Checkbox checked={form.ack} onChange={(v) => set("ack", v)}>
                      I understand; publish it without a login
                    </Checkbox>
                    {errors.ack && <p className={f.error}>{errors.ack}</p>}
                  </div>
                </Notice>
              )}
            </div>
          )}

          {step === "review" && (
            <div className={f.section}>
              <p className={f.reviewUrl}>
                <span className="mono">{bare(url)}</span>
              </p>
              <MiniLane
                lane={mode === "fallback" ? "cloudflare" : direct ? "direct" : "cloudflare"}
                end={
                  mode === "redirect" ? (
                    <span className={f.laneEnd}>
                      <span className={f.laneEndName}>Sends visitors on</span>
                      <span className={`${f.laneEndSub} mono`}>{bare(form.target) || "…"}</span>
                    </span>
                  ) : (
                    <span className={f.laneEnd}>
                      <AppIcon src={app?.icon} name={appName ?? (form.name || "App")} size={22} />
                      <span className={f.laneEndText}>
                        <span className={f.laneEndName}>{appName ?? (form.name || "App")}</span>
                        <span className={`${f.laneEndSub} mono`}>
                          {localBackend ? "" : `${form.backendHost}`}:{form.port || "…"}
                          {form.tls ? " https" : ""}
                        </span>
                      </span>
                    </span>
                  )
                }
              />
              {steps.length > 1 && (
                <dl className={f.recap}>
                  {steps.includes("app") && (
                    <RecapRow label="App" onChange={() => go("app")}>
                      {(mode === "fallback" && form.other ? form.name : appName) || "Something else"} <span className={`${f.dim} mono`}>:{form.port || "…"}</span>
                    </RecapRow>
                  )}
                  {steps.includes("address") && (
                    <RecapRow label="Address" onChange={() => go("address")}>
                      <span className="mono">{bare(url)}</span>{" "}
                      <span className={f.dim}>{mode === "redirect" ? "short link" : direct ? "direct" : "through Cloudflare"}</span>
                    </RecapRow>
                  )}
                  {steps.includes("protection") && (
                    <RecapRow label="Protection" onChange={() => go("protection")}>
                      {direct && form.scope === "some" ? "Only some paths" : loginVerdict === "login" ? "Its own login" : loginVerdict === "none" ? "No login" : "Not sure it has a login"}
                    </RecapRow>
                  )}
                </dl>
              )}
              <ul className={f.facts}>
                {mode === "fallback" ? (
                  <>
                    <li>Anything on {base} that no other address or short link claims opens {(form.other ? form.name : appName) || "this app"}.</li>
                    <li>It goes through Cloudflare, so uploads over 100 MB fail.</li>
                  </>
                ) : mode === "redirect" ? (
                  <>
                    <li>
                      <span className="mono">{bare(url)}</span> sends visitors to <span className="mono">{bare(form.target) || "…"}</span>, keeping anything after the path.
                    </li>
                    <li>{base} already points at Cloudflare, so there&rsquo;s nothing to set up.</li>
                  </>
                ) : (
                  <>
                    <li>
                      {direct
                        ? form.customHost
                          ? `Needs a DNS record for ${host} pointing to ${publicIp ?? "your internet address"} before it works.`
                          : "The wildcard DNS record already covers this name; nothing to set up in Cloudflare."
                        : `${base} already points at Cloudflare; nothing to set up.`}
                    </li>
                    <li>{direct ? "Direct: video and big uploads work; visitors can see your home's internet address." : "Through Cloudflare: your address stays hidden, but uploads over 100 MB fail and video isn't allowed."}</li>
                    {(!existing || (existing.type === "subdomain" ? existing.host !== host : true)) && <li>The web server fetches an HTTPS certificate within a minute of saving.</li>}
                    <li>
                      {direct && form.scope === "some"
                        ? `Only ${onlyPaths.join(", ")} ${onlyPaths.length === 1 ? "is" : "are"} reachable; everything else answers “not found”.`
                        : loginVerdict === "login"
                          ? `${appName ?? "The app"} asks visitors to sign in.`
                          : loginVerdict === "none"
                            ? `${appName ?? "The app"} has no login: anyone who finds the address can use it.`
                            : `Gluon isn't sure ${appName ?? "the app"} asks for a login; check that it does.`}
                    </li>
                    {direct && form.shortLink && (
                      <li>
                        Also reachable at <span className="mono">{base}/{cleanPath(form.shortPath)}</span>, which redirects here.
                      </li>
                    )}
                    {!direct && !form.stripPrefix && <li>The app must be set up to live under /{cleanPath(form.path)} (its “base URL” setting).</li>}
                    {existing?.type === "subdomain" && !direct && ownLinks.length > 0 && <li>Its short link{ownLinks.length === 1 ? "" : "s"} ({ownLinks.map((l) => l.path).join(", ")}) will be removed, since the subdomain goes away.</li>}
                    {existing?.type === "subdomain" && direct && existing.host !== host && ownLinks.length > 0 && <li>Short links to the old name now lead to the new one.</li>}
                  </>
                )}
              </ul>
              {existing && mode !== "fallback" && (
                <Checkbox checked={form.enabled} onChange={(v) => set("enabled", v)}>
                  On the internet
                  <span className={f.hint}>Turn off to keep the settings but stop answering visitors.</span>
                </Checkbox>
              )}
            </div>
          )}
        </div>
        </div>
        {/* Enter in a text field moves forward. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function RecapRow({ label, onChange, children }: { label: string; onChange: () => void; children: React.ReactNode }) {
  return (
    <div className={f.recapRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
      <Button size="sm" variant="ghost" onClick={onChange} aria-label={`Change the ${label.toLowerCase()}`}>
        Change
      </Button>
    </div>
  );
}

function Availability({ a }: { a: { state: "running" | "unhealthy"; text: string } }) {
  return (
    <span className={f.avail}>
      <StateLine state={a.state} label={a.text} />
    </span>
  );
}

function LaneChoice({ on, onPick, icon, title, example, text }: { on: boolean; onPick: () => void; icon: React.ReactNode; title: string; example: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={f.choice} data-on={on ? "" : undefined} onClick={onPick}>
      <span className={f.choiceHead}>
        <span className={f.choiceIcon} aria-hidden>
          {icon}
        </span>
        <span className={f.choiceTitle}>{title}</span>
        <span className={f.radio} aria-hidden />
      </span>
      <span className={`${f.choiceExample} mono`}>{example}</span>
      <span className={f.choiceText}>{text}</span>
    </button>
  );
}

function ScopeChoice({ on, onPick, title, text }: { on: boolean; onPick: () => void; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={f.choice} data-on={on ? "" : undefined} onClick={onPick}>
      <span className={f.choiceHead}>
        <span className={f.choiceTitle}>{title}</span>
        <span className={f.radio} aria-hidden />
      </span>
      <span className={f.choiceText}>{text}</span>
    </button>
  );
}

/** Where the address will sit on the map: one lane from a visitor to the app. */
function MiniLane({ lane, end }: { lane: "direct" | "cloudflare"; end: React.ReactNode }) {
  const hops: { icon: React.ReactNode; name: string }[] = [
    { icon: <Internet />, name: "Anyone" },
    { icon: lane === "direct" ? <Cloud /> : <CloudSync />, name: lane === "direct" ? "Direct" : "Through Cloudflare" },
    { icon: <HomeSimpleDoor />, name: "Your router" },
    { icon: <Server />, name: "Web server" },
  ];
  return (
    <ol className={f.lane} aria-label={`Visitors go ${lane === "direct" ? "directly" : "through Cloudflare"} to your router, then the web server, then the app.`}>
      {hops.map((h) => (
        <li key={h.name} className={f.laneHop}>
          <span className={f.laneIcon} aria-hidden>
            {h.icon}
          </span>
          <span className={f.laneName}>{h.name}</span>
        </li>
      ))}
      <li className={`${f.laneHop} ${f.laneApp}`}>{end}</li>
    </ol>
  );
}
