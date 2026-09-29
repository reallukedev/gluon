/**
 * First drafts: what Gluon makes of an image, a pasted compose file or a repository before the
 * person has touched anything. Everything here is a suggestion shown on the New app page.
 */
import type { AppDetails, AppSpec, BuilderSource, BuilderTarget, ImageLookup, SecretNames, WebSettings } from "@/lib/builder-types";
import { applyAllFixes, mergeSecrets } from "./analyze";
import { newCompose, parseCompose, readService, readServices, serviceNames, setEnv, setPorts, setVolumes, stringify, scalarText } from "./compose";
import { looksSecret, parseImage, SERVICE_RE, slugify } from "./names";

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

/** The port most likely to be the web page. */
export function pickWebPort(ports: { port: number; proto: "tcp" | "udp" }[]): number | null {
  const tcp = ports.filter((p) => p.proto === "tcp" && !NOT_WEB.has(p.port)).map((p) => p.port);
  return WEB_PORTS.find((p) => tcp.includes(p)) ?? tcp[0] ?? null;
}

const folderFor = (path: string) =>
  path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((p) => p && !["var", "lib", "usr", "src", "app", "opt", "srv", "home"].includes(p))
    .slice(-2)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-") || "data";

/** A one-service app from an image and what its registry says about it. */
export function specFromImage(image: string, lookup: ImageLookup | null, name?: string): AppSpec {
  const ref = parseImage(image);
  const last = ref.repository.split("/").pop() ?? "app";
  const svc = SERVICE_RE.test(slugify(last)) ? slugify(last) : "app";
  const appName = name?.trim() || titleize(last);
  const doc = parseCompose(newCompose(svc, image.trim())).doc;
  const web = blankWeb();
  if (lookup) {
    const webPort = pickWebPort(lookup.ports);
    const rest = lookup.ports.filter((p) => !(p.port === webPort && p.proto === "tcp"));
    if (rest.length) setPorts(doc, svc, rest.map((p) => ({ host: p.port, container: p.port, proto: p.proto, ip: "", raw: null })));
    if (webPort) Object.assign(web, { service: svc, containerPort: webPort, port: webPort });
    const seen = new Set<string>();
    const vols = lookup.volumes.map((v) => {
      let f = folderFor(v);
      while (seen.has(f)) f = `${f}-2`;
      seen.add(f);
      return { kind: "data" as const, source: f, target: v, readOnly: false, raw: null, long: false };
    });
    if (vols.length) setVolumes(doc, svc, vols);
  }
  // LinuxServer images run as the user PUID/PGID says, in the timezone TZ says.
  if (/(^|\/)linuxserver\/|^lscr\.io\//.test(image)) {
    const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Etc/UTC";
    setEnv(doc, svc, [
      { key: "PUID", value: "1000", interpolated: false },
      { key: "PGID", value: "1000", interpolated: false },
      { key: "TZ", value: tz || "Etc/UTC", interpolated: false },
    ]);
  }
  const details = blankDetails(appName);
  if (lookup?.description) details.tagline = lookup.description.split(/(?<=\.)\s/)[0]!.slice(0, 120);
  if (ref.tag && /^v?\d+(\.\d+)*$/.test(ref.tag)) details.version = ref.tag.replace(/^v/, "");
  if (ref.registry === "docker.io") details.website = `https://hub.docker.com/${ref.repository.startsWith("library/") ? `_/${last}` : `r/${ref.repository}`}`;
  else if (ref.registry === "ghcr.io") details.website = `https://github.com/${ref.repository.split("/").slice(0, 2).join("/")}`;
  return { details, web, compose: stringify(doc) };
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
