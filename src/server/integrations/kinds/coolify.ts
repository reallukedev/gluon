import "server-only";
import { z } from "zod";
import { client, ok, runTest, str, UpstreamError, type KindContext, type KindDef, type KindSearchHit } from "./base";
import { cached } from "../cache";
import { deploymentList, mergeRecent, parseVersion, toDeployment, toResource } from "./coolify-map";
import type { CoolifyDeployment, CoolifyDeploymentsData, CoolifyResource } from "@/lib/widgets-types";

const schema = z.object({
  apiToken: z.string().trim().min(10, "Paste the whole API token from Coolify.").max(500),
  allowSelfSigned: z.boolean().default(false),
});
type Config = z.infer<typeof schema>;
type Ctx = KindContext<Config>;

const UUID = /^[A-Za-z0-9]{6,64}$/;
/** Applications whose history the widget reads, most recently changed first (one request each). */
const HISTORY_APPS = 10;

function http(ctx: Ctx) {
  return client(def, ctx, (status, body) => {
    if (status === 401) return "Coolify didn't accept the API token. Make a new one in Coolify under Keys & Tokens → API tokens.";
    if (/disabled|not allowed to access the api/i.test(body)) return "Coolify's API is turned off. Turn on API access in Coolify's Settings, then try again.";
    return "Coolify refused: this API token can't read that. Give it read access.";
  });
}

const key = (ctx: Ctx, what: string) => `int:${ctx.id ?? ctx.baseUrl}:${ctx.version}:coolify:${what}`;

async function version(ctx: Ctx): Promise<string | null> {
  const r = await cached(key(ctx, "version"), 30 * 60_000, async () => {
    const res = await http(ctx).raw("/api/v1/version", { headers: { Accept: "text/plain, application/json" } });
    return parseVersion(res.body.toString("utf8").slice(0, 200));
  });
  return r.value;
}

async function resources(ctx: Ctx): Promise<CoolifyResource[]> {
  const r = await cached(key(ctx, "resources"), 8000, async () => {
    const list = await http(ctx).json<unknown>("/api/v1/resources", { maxBytes: 8 * 1024 * 1024 });
    return (Array.isArray(list) ? list : []).map(toResource).filter((x): x is CoolifyResource => !!x);
  });
  return r.value;
}

async function history(ctx: Ctx, take: number): Promise<{ list: CoolifyDeployment[]; note: string | null }> {
  const h = http(ctx);
  const apps = await h.json<unknown>("/api/v1/applications", { maxBytes: 8 * 1024 * 1024 });
  const recent = (Array.isArray(apps) ? (apps as Record<string, unknown>[]) : [])
    .filter((a) => typeof a.uuid === "string" && UUID.test(a.uuid))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, HISTORY_APPS);
  if (!recent.length) return { list: [], note: null };
  let unsupported = false;
  const lists = await Promise.all(
    recent.map(async (a) => {
      const res = await h.json<unknown>(`/api/v1/deployments/applications/${a.uuid}`, { query: { skip: 0, take }, allow: [400, 404] }).catch(() => null);
      if (res && typeof res === "object" && "__status" in res) {
        unsupported = true;
        return [];
      }
      return deploymentList(res)
        .map((d) => toDeployment(d, str(a.name)))
        .filter((d): d is CoolifyDeployment => !!d);
    }),
  );
  return { list: lists.flat(), note: unsupported && !lists.some((l) => l.length) ? "This Coolify doesn't share past deployments with other apps. Updating Coolify adds them." : null };
}

async function deployments(ctx: Ctx, params: Record<string, unknown>): Promise<CoolifyDeploymentsData> {
  const limit = typeof params.limit === "number" ? params.limit : 6;
  const h = http(ctx);
  const [running, res, past, v] = await Promise.all([
    h.json<unknown>("/api/v1/deployments", { allow: [404] }),
    resources(ctx),
    history(ctx, Math.min(limit, 5)).catch((e) => {
      if (e instanceof UpstreamError && e.upstreamStatus === 403) return { list: [], note: "This API token can't read deployments. Give it read access in Coolify." };
      throw e;
    }),
    version(ctx).catch(() => null),
  ]);
  const runningList = deploymentList(running)
    .map((d) => toDeployment(d))
    .filter((d): d is CoolifyDeployment => !!d);
  const isActive = (d: CoolifyDeployment) => d.status === "queued" || d.status === "in_progress";
  const active = [...new Map([...runningList, ...past.list].filter(isActive).map((d) => [d.id, d])).values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const recent = mergeRecent([past.list.filter((d) => !isActive(d))], limit);
  const problems = res.filter((r) => r.line !== "running");
  return {
    version: v,
    active,
    recent,
    resources: { total: res.length, running: res.length - problems.length, problems: problems.slice(0, 12) },
    historyNote: past.note,
  };
}

const TYPE_WORD: Record<CoolifyResource["type"], string> = { application: "Application", service: "Service", database: "Database", other: "Resource" };
const LINE_WORD: Record<string, string> = { running: "running", unhealthy: "not healthy", stopped: "stopped", starting: "starting", paused: "paused", unknown: "state unknown", attention: "needs you" };

async function search(ctx: Ctx, q: string, opts: { limit: number; signal: AbortSignal }): Promise<KindSearchHit[]> {
  const term = q.trim().toLowerCase();
  if (term.length < 2 || opts.limit < 1) return [];
  const list = await new Promise<CoolifyResource[]>((resolve, reject) => {
    if (opts.signal.aborted) return reject(opts.signal.reason);
    const onAbort = () => reject(opts.signal.reason);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    resources(ctx)
      .then(resolve, reject)
      .finally(() => opts.signal.removeEventListener("abort", onAbort));
  });
  return list
    .filter((r) => r.name.toLowerCase().includes(term))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)) || a.name.localeCompare(b.name))
    .slice(0, opts.limit)
    .map((r) => ({ id: r.id, label: r.name, hint: `${TYPE_WORD[r.type]} in Coolify · ${LINE_WORD[r.line] ?? r.status}`, type: r.type === "application" ? "app" : r.type }));
}

export const def: KindDef<Config> = {
  kind: "coolify",
  label: "Coolify",
  description: "Deployments in progress, ones that failed, and resources that aren't running, from Coolify.",
  baseUrlLabel: "Coolify address",
  baseUrlPlaceholder: "http://127.0.0.1:8000",
  keyHelp:
    "In Coolify, open Keys & Tokens → API tokens, create a token called “Gluon” with read access, and paste it here. If Coolify says its API is off, turn on API access in Settings first.",
  fields: [
    { key: "apiToken", label: "API token", type: "password", required: true, secret: true },
    { key: "allowSelfSigned", label: "Allow self-signed certificate", type: "boolean", required: false, secret: false },
  ],
  schema,
  secretKeys: ["apiToken"],
  widgets: ["coolify.deployments"],
  insecureTls: (c) => c.allowSelfSigned,
  authorize(ctx, req) {
    req.headers.Authorization = `Bearer ${ctx.config.apiToken}`;
  },
  test: (ctx) =>
    runTest(async () => {
      const h = http(ctx);
      const health = await h.raw("/api/health", { noAuth: true, allow: [404] });
      if (health.status === 404) throw new UpstreamError("That address answered, but it doesn't look like Coolify.");
      const v = parseVersion((await h.raw("/api/v1/version", { headers: { Accept: "text/plain, application/json" } })).body.toString("utf8").slice(0, 200));
      const res = await h.json<unknown>("/api/v1/resources");
      const n = Array.isArray(res) ? res.length : 0;
      return ok(`Connected to Coolify${v ? ` ${v}` : ""}.`, {
        version: v,
        detail: n ? `Gluon can see ${n} ${n === 1 ? "resource" : "resources"}.` : "Coolify has nothing deployed yet. The widget fills in once it does.",
      });
    }),
  data: {
    "coolify.deployments": (ctx, p) => deployments(ctx, p),
  },
  search: (ctx, q, opts) => search(ctx, q, opts),
};
