/**
 * First drafts: what Gluon makes of an image, a pasted compose file or a repository before the
 * person has touched anything. Everything here is a suggestion shown on the New app page.
 */
import type { AppDetails, AppSpec, BuilderSource, BuilderTarget, ImageLookup, SecretNames, WebSettings } from "@/lib/builder-types";
import { applyAllFixes, mergeSecrets } from "./analyze";
import { newCompose, parseCompose, readService, readServices, serviceNames, setEnv, setPendingFolders, setPorts, setVolumes, stringify, scalarText, type EnvRow } from "./compose";
import { dataFolderFor, isLinuxServerImage, linuxServerEnv, looksSecret, mediaKind, parseImage, RESERVED_SERVICES, SERVICE_RE, slugify } from "./names";

export const WEB_PORTS = [80, 8080, 3000, 8000, 8096, 5000, 9000, 8081, 8888, 3001, 5173, 4000, 8123, 8443, 443];
const NOT_WEB = new Set([22, 25, 53, 110, 143, 465, 587, 993, 995, 1883, 3306, 5432, 6379, 27017, 11211, 5353, 1900, 7359]);

export function blankDetails(name: string): AppDetails {
  return { name, slug: slugify(name), tagline: "", description: "", category: "other", icon: null, website: "", support: "", developer: "", version: "1.0.0", releaseNotes: "" };
}

export const blankWeb = (): WebSettings => ({ service: null, containerPort: null, port: null, path: "", umbrelAuth: true });

export const titleize = (s: string) =>
  s
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** The first port from `want` up that nothing on the server uses. */
export function nextFreePort(want: number, used: { has: (p: number) => boolean }): number | null {
  for (let p = Math.max(1024, want); p < 65536 && p < want + 2000; p++) if (!used.has(p)) return p;
  return null;
}

/** The port most likely to be the web page. */
export function pickWebPort(ports: { port: number; proto: "tcp" | "udp" }[]): number | null {
  const tcp = ports.filter((p) => p.proto === "tcp" && !NOT_WEB.has(p.port)).map((p) => p.port);
  return WEB_PORTS.find((p) => tcp.includes(p)) ?? tcp[0] ?? null;
}

/** What the New app flow makes of an image: the spec, secret values it lifted, and what it did in words. */
export interface ImageDraft {
  spec: AppSpec;
  secretValues: Record<string, Record<string, string>>;
  said: string[];
}

/** The service name an image gets: its repository's last part when that's a valid name. */
export function serviceNameFor(image: string): string {
  const last = parseImage(image).repository.split("/").pop() ?? "app";
  const svc = slugify(last);
  return SERVICE_RE.test(svc) && !RESERVED_SERVICES.has(svc) ? svc : "app";
}

/** A friendly app name from an image reference: linuxserver/jellyfin:latest → Jellyfin. */
export function nameForImage(image: string): string {
  const parts = parseImage(image).repository.split("/");
  const last = parts.pop() ?? "";
  // vaultwarden/server reads better as Vaultwarden than as Server.
  const owner = parts.pop();
  if (owner && owner !== "library" && /^(server|app|web|api|core|docker|main|service|image)$/i.test(last)) return titleize(owner);
  return titleize(last);
}

/**
 * A one-service app from an image and what its registry says about it: the web page on its most
 * likely port, the other ports, each declared volume as an app-data folder, and the image's own
 * environment defaults so they can be seen and changed. Secret-looking defaults become secrets.
 */
export function draftFromImage(image: string, lookup: ImageLookup | null, name?: string): ImageDraft {
  const ref = parseImage(image);
  const svc = serviceNameFor(image);
  const appName = name?.trim() || nameForImage(image);
  const doc = parseCompose(newCompose(svc, image.trim())).doc;
  const web = blankWeb();
  const said: string[] = [];
  const secretValues: Record<string, Record<string, string>> = {};
  if (lookup) {
    const webPort = pickWebPort(lookup.ports);
    const rest = lookup.ports.filter((p) => !(p.port === webPort && p.proto === "tcp"));
    if (rest.length) setPorts(doc, svc, rest.map((p) => ({ host: p.port, container: p.port, proto: p.proto, ip: "", raw: null })));
    if (webPort) Object.assign(web, { service: svc, containerPort: webPort, port: webPort });
    const taken = new Set<string>();
    // Media libraries wait for a server folder; everything else is kept with the app.
    const media = lookup.volumes.filter((v) => mediaKind(v));
    const vols = lookup.volumes.filter((v) => !mediaKind(v)).map((v) => ({ kind: "data" as const, source: dataFolderFor(v, taken), target: v, readOnly: false, raw: null, long: false }));
    if (vols.length) setVolumes(doc, svc, vols);
    if (media.length) {
      setPendingFolders(doc, svc, media);
      said.push(`Choose where your ${[...new Set(media.map((m) => mediaKind(m)))].join(" and ")} ${media.length === 1 ? "is" : "are"} next: ${media.join(", ")} ${media.length === 1 ? "is" : "are"} mounted from a server folder, never kept in app data.`);
    }
  }
  const env: EnvRow[] = [];
  const lsio = isLinuxServerImage(image);
  if (lsio) for (const e of linuxServerEnv()) env.push({ ...e, interpolated: false });
  for (const e of lookup?.env ?? []) {
    if (env.some((x) => x.key === e.key)) continue;
    if (looksSecret(e.key)) {
      // An empty secret default means the image doesn't need it set.
      if (e.value) (secretValues[svc] ??= {})[e.key] = e.value;
      continue;
    }
    env.push({ key: e.key, value: e.value, interpolated: false });
  }
  if (env.length) setEnv(doc, svc, env);
  if (lsio) said.push("PUID, PGID and TZ are set, which LinuxServer images read.");
  const fromImage = (lookup?.env ?? []).filter((e) => !(lsio && ["PUID", "PGID", "TZ"].includes(e.key)) && (!looksSecret(e.key) || e.value));
  if (fromImage.length) said.push(`${fromImage.length === 1 ? "The image's own setting" : `The image's own ${fromImage.length} settings`} ${fromImage.length === 1 ? "is" : "are"} filled in, so you can see and change ${fromImage.length === 1 ? "it" : "them"}.`);
  const details = blankDetails(appName);
  if (lookup?.description) details.tagline = lookup.description.split(/(?<=\.)\s/)[0]!.slice(0, 120);
  if (ref.tag && /^v?\d+(\.\d+)*$/.test(ref.tag)) details.version = ref.tag.replace(/^v/, "");
  const last = ref.repository.split("/").pop() ?? "app";
  if (ref.registry === "docker.io") details.website = `https://hub.docker.com/${ref.repository.startsWith("library/") ? `_/${last}` : `r/${ref.repository}`}`;
  else if (ref.registry === "ghcr.io") details.website = `https://github.com/${ref.repository.split("/").slice(0, 2).join("/")}`;
  return { spec: { details, web, compose: stringify(doc) }, secretValues, said };
}

/** Guess the web page of a compose file: a service publishing a web-looking port. */
export function guessWeb(text: string): Partial<WebSettings> {
  const p = parseCompose(text);
  if (!p.ok) return {};
  const forms = readServices(p.doc).filter((f) => f.name !== "app_proxy");
  let best: { svc: string; host: number; container: number; score: number } | null = null;
  for (const f of forms) {
    for (const port of f.ports) {
      if (port.raw !== null || !port.container || port.proto !== "tcp" || NOT_WEB.has(port.container)) continue;
      const rank = WEB_PORTS.indexOf(port.container);
      const score = (rank < 0 ? 50 : rank) + (/(web|app|server|ui|frontend)/.test(f.name) ? -20 : 0) + (/(db|redis|postgres|mysql|mariadb|cache|worker)/.test(f.name) ? 100 : 0);
      if (!best || score < best.score) best = { svc: f.name, host: port.host ?? port.container, container: port.container, score };
    }
    if (!best && f.hostNetwork && forms.length === 1) return {};
  }
  return best ? { service: best.svc, containerPort: best.container, port: best.host } : {};
}

export interface Prepared {
  text: string;
  web: WebSettings;
  secrets: SecretNames;
  /** Secret values lifted out of the file (they go up with the draft, then never come back). */
  secretValues: Record<string, Record<string, string>>;
  said: string[];
  name: string | null;
}

/**
 * Make a pasted (or repository) compose file ready for the builder: find the web page, apply every
 * fix Gluon can make, and lift secret-looking values out of the file.
 */
export function prepareCompose(text: string, target: BuilderTarget, source: BuilderSource, webIn: Partial<WebSettings> = {}): Prepared {
  const web: WebSettings = { ...blankWeb(), ...guessWeb(text), ...webIn };
  const original = parseCompose(text);
  const projectName = original.ok ? scalarText(original.doc.get("name", true)) : null;
  const fixed = applyAllFixes(text, { source, target, web, secrets: {} });
  const merged: WebSettings = { ...web, ...fixed.web };
  let out = fixed.text;
  const said = [...fixed.said];
  const secretValues: Record<string, Record<string, string>> = {};
  const p = parseCompose(out);
  let name: string | null = null;
  if (p.ok) {
    const x = p.doc.get("x-casaos", true) as { get?: (k: string) => unknown } | undefined;
    const title = x?.get ? scalarText((x.get("title") as { get?: (k: string) => unknown })?.get?.("en_us") ?? x.get("title")) : null;
    name = title || (projectName ? titleize(projectName) : null);
    for (const svc of serviceNames(p.doc)) {
      const f = readService(p.doc, svc);
      const lift = f.env.filter((e) => looksSecret(e.key) && !e.interpolated && e.value);
      if (!lift.length) continue;
      secretValues[svc] = Object.fromEntries(lift.map((e) => [e.key, e.value]));
      setEnv(p.doc, svc, f.env.filter((e) => !lift.includes(e)));
      said.push(`${lift.map((e) => e.key).join(", ")} of “${svc}” ${lift.length === 1 ? "is" : "are"} kept as ${lift.length === 1 ? "a secret" : "secrets"}: encrypted, and out of the file.`);
    }
    if (Object.keys(secretValues).length) out = stringify(p.doc);
  }
  const secrets = mergeSecrets(fixed.secrets, Object.fromEntries(Object.entries(secretValues).map(([k, v]) => [k, Object.keys(v)])));
  return { text: out, web: merged, secrets, secretValues, said, name };
}
