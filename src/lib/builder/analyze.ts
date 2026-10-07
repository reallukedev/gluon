/**
 * Checks a custom app before it's published, and the fixes Gluon can make itself. Everything here
 * is local and instant (runs as the person types); checks that need the server (ports in use,
 * registries, Umbrel's app list) live in server/appstore/checks.ts and return the same Issue shape.
 */
import { YAMLMap, isMap, isSeq, type Document } from "yaml";
import type { AppSpec, BuilderSource, BuilderTarget, Issue, SecretNames, WebSettings } from "@/lib/builder-types";
import {
  DATA_PREFIX,
  PENDING_KEY,
  declareNetwork,
  setPendingFolders,
  lineOf,
  nodeJs,
  parseCompose,
  readNetworks,
  readService,
  scalarText,
  serviceNames,
  serviceNode,
  servicesMap,
  setEnv,
  setPorts,
  setVolumes,
  stringify,
  variablesIn,
  type ParsedCompose,
  type ServiceForm,
  type VolumeRow,
} from "./compose";
import {
  DEVICE_RE,
  containerPathError,
  cpusError,
  dataFolderError,
  durationError,
  envNameError,
  envValueError,
  hostPathError,
  iconError,
  looksSecret,
  imageError,
  labelKeyError,
  mediaKind,
  memoryError,
  nameError,
  networkNameError,
  portError,
  repoPathError,
  serviceNameError,
  slugError,
  taglineError,
  urlError,
} from "./names";

export interface AnalyzeContext {
  source: BuilderSource;
  target: BuilderTarget;
  web: WebSettings;
  secrets: SecretNames;
}

export interface Analysis {
  parsed: ParsedCompose;
  services: ServiceForm[];
  issues: Issue[];
}

/** Variables Umbrel sets for every app (legacy app-script `source_app`). */
const UMBREL_VARS = new Set([
  "APP_DATA_DIR", "APP_ID", "APP_PASSWORD", "APP_SEED", "APP_DOMAIN", "APP_HIDDEN_SERVICE", "APP_VERSION", "APP_PROXY_HOSTNAME",
  "APP_PROXY_PORT", "APP_MANIFEST_FILE", "DEVICE_HOSTNAME", "DEVICE_DOMAIN_NAME", "NETWORK_IP", "TOR_PROXY_IP", "TOR_PROXY_PORT",
  "TOR_DATA_DIR", "UMBREL_ROOT",
]);
/** What Gluon's .env gives a compose app it runs itself. */
const COMPOSE_VARS = new Set(["APP_DATA_DIR", "APP_ID"]);

const SENSITIVE_HOST = [/^\/$/, /^\/etc(\/|$)/, /^\/root(\/|$)/, /^\/boot(\/|$)/, /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/dev\/?$/];

function lineAt(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  return i < 0 ? undefined : text.slice(0, i).split("\n").length;
}

export function analyze(text: string, ctx: AnalyzeContext): Analysis {
  const parsed = parseCompose(text);
  const issues: Issue[] = [...parsed.issues];
  const umbrel = ctx.target === "umbrel";
  if (!text.trim()) {
    issues.push({ id: "empty", level: "error", message: "The compose file is empty. Add at least one service." });
    return { parsed, services: [], issues };
  }
  if (!parsed.ok) return { parsed, services: [], issues };
  const { doc, lines } = parsed;
  if (!isMap(doc.contents)) {
    issues.push({ id: "root", level: "error", message: "A compose file is a map with a services: section at the top.", line: 1 });
    return { parsed, services: [], issues };
  }
  const services = servicesMap(doc);
  if (!services || services.items.length === 0) {
    issues.push({ id: "no-services", level: "error", message: "There's no services: section. A compose file needs at least one service.", line: lineOf(doc.get("services", true), lines) ?? 1 });
    return { parsed, services: [], issues };
  }

  // ------------------------------------------------ top level
  const top = doc.contents as YAMLMap;
  for (const p of top.items) {
    const key = scalarText(p.key) ?? "";
    const line = lineOf(p.key, lines);
    if (key === "version") issues.push({ id: "version", level: "info", message: `Line ${line}: version: is obsolete and ignored.`, line, fix: { id: "rm-version", label: "Remove it" } });
    else if (key === "name") issues.push({ id: "name", level: umbrel ? "warning" : "info", message: umbrel ? `Line ${line}: Umbrel names the project after the app, so name: would break it.` : `Line ${line}: Gluon names the project after the app id.`, line, fix: { id: "rm-name", label: "Remove it" } });
    else if (key === "secrets" || key === "configs") issues.push({ id: `top-${key}`, level: "error", message: `Line ${line}: compose ${key} aren't supported here. Put the values in Environment and mark them secret.`, line });
    else if (key === "include") issues.push({ id: "include", level: "error", message: `Line ${line}: include: can't be used; paste the included services into this file.`, line });
    else if (key === "networks" && umbrel) issues.push({ id: "networks", level: "warning", message: `Line ${line}: Umbrel connects every app to its own network, so custom networks aren't needed and can stop the app from starting.`, line, fix: { id: "rm-networks", label: "Remove custom networks" } });
    else if (key !== "services" && key !== "volumes" && key !== "networks" && !key.startsWith("x-")) issues.push({ id: `top-${key}`, level: "warning", message: `Line ${line}: ${key}: isn't a compose section Gluon knows; it's published as written.`, line });
  }
  const topVolumes = doc.get("volumes", true);
  const namedDecl = new Map<string, Record<string, unknown>>();
  if (isMap(topVolumes)) for (const p of topVolumes.items) namedDecl.set(scalarText(p.key) ?? "", (isMap(p.value) ? nodeJs<Record<string, unknown>>(p.value, doc) : {}) ?? {});

  const declaredNets = new Set(readNetworks(doc).map((n) => n.name));

  // ------------------------------------------------ services
  const names = serviceNames(doc);
  const forms = names.map((n) => readService(doc, n));
  const hostPorts = new Map<string, string>();
  const fromEnv = new Set<string>();
  const secretSet = (svc: string) => new Set(ctx.secrets[svc] ?? []);

  for (const f of forms) {
    const node = serviceNode(doc, f.name);
    const at = (k: string) => lineOf(node?.get(k, true), lines) ?? lineOf(services.items.find((p) => scalarText(p.key) === f.name)?.key, lines);
    const sLine = lineOf(services.items.find((p) => scalarText(p.key) === f.name)?.key, lines);
    const field = (k: string) => `services.${f.name}.${k}`;

    if (f.name === "app_proxy") {
      issues.push({ id: "app-proxy", level: "error", message: `app_proxy is Umbrel's own service. Gluon makes it from the Web page settings.`, line: sLine, field: "web.service", fix: { id: "app-proxy", label: "Use it for the web page settings" } });
      continue;
    }
    const nameErr = serviceNameError(f.name);
    if (nameErr) issues.push({ id: `svc-name-${f.name}`, level: "error", message: `Service “${f.name}”: ${nameErr}`, line: sLine, field: field("name") });
    if (!node) {
      issues.push({ id: `svc-shape-${f.name}`, level: "error", message: `Service “${f.name}” should be a map of settings.`, line: sLine });
      continue;
    }

    // image / build
    if (f.build) {
      if (ctx.source !== "github") {
        issues.push({ id: `build-${f.name}`, level: "error", message: `“${f.name}” builds from a folder. Umbrel can only run published images, so use an image, or start from a GitHub repository and Gluon builds it for you.`, line: at("build"), field: field("image") });
      } else {
        const ctxErr = /^[a-z]+:\/\//i.test(f.build.context) || f.build.context.startsWith("git@") ? "Build contexts must be a folder in this repository." : repoPathError(f.build.context.replace(/^\.\/?/, ""));
        if (ctxErr) issues.push({ id: `build-ctx-${f.name}`, level: "error", message: `“${f.name}”: ${ctxErr}`, line: at("build"), field: field("build") });
        if (f.build.dockerfile && (f.build.dockerfile.startsWith("/") || f.build.dockerfile.split("/").includes(".."))) issues.push({ id: `build-df-${f.name}`, level: "error", message: `“${f.name}”: the Dockerfile has to be inside the build folder.`, line: at("build"), field: field("build") });
      }
    } else if (!f.image) {
      issues.push({ id: `image-${f.name}`, level: "error", message: `“${f.name}” needs an image.`, line: sLine, field: field("image") });
    } else {
      const e = imageError(f.image);
      if (e) issues.push({ id: `image-${f.name}`, level: "error", message: `“${f.name}”: ${e}`, line: at("image"), field: field("image") });
      else if (f.image.includes("$")) issues.push({ id: `image-var-${f.name}`, level: "info", message: `“${f.name}” picks its image from a variable.`, line: at("image"), field: field("image") });
    }

    // keys Umbrel can't take
    if (node.has("extends")) issues.push({ id: `extends-${f.name}`, level: "error", message: `“${f.name}” uses extends:, which can't be published. Copy the settings into this service.`, line: at("extends") });
    if (node.has("profiles")) issues.push({ id: `profiles-${f.name}`, level: "warning", message: `“${f.name}” has profiles:, so it wouldn't start with the app.`, line: at("profiles"), fix: { id: `rm-profiles:${f.name}`, label: "Always start it" } });
    if (node.has("env_file")) issues.push({ id: `envfile-${f.name}`, level: "warning", message: `“${f.name}” reads an env_file that won't exist on the server. Add its variables under Environment instead.`, line: at("env_file"), field: field("env"), fix: { id: `rm-envfile:${f.name}`, label: "Remove env_file" } });
    if (node.has("networks") && umbrel && !f.hostNetwork) issues.push({ id: `svc-networks-${f.name}`, level: "warning", message: `“${f.name}” joins custom networks. On Umbrel every app shares its own network.`, line: at("networks"), fix: { id: "rm-networks", label: "Remove custom networks" } });
    if (f.containerName) issues.push({ id: `cname-${f.name}`, level: "info", message: `“${f.name}” has a fixed container name. That's fine unless another container already uses “${f.containerName}”.`, line: at("container_name"), fix: { id: `rm-container-name:${f.name}`, label: umbrel ? "Let Umbrel name it" : "Let Compose name it" } });
    if (f.privileged) issues.push({ id: `priv-${f.name}`, level: "warning", message: `“${f.name}” runs privileged: it can do anything on this server.`, line: at("privileged"), field: field("advanced") });
    if (f.networkMode && f.networkMode !== "host" && f.networkMode !== "bridge") issues.push({ id: `netmode-${f.name}`, level: "info", message: `“${f.name}” uses network_mode: ${f.networkMode}.`, line: at("network_mode") });

    // ports
    f.ports.forEach((p, i) => {
      const portSeq = node.get("ports", true);
      const line = lineOf(isSeq(portSeq) ? portSeq.items[i] : undefined, lines);
      if (p.raw !== null) {
        issues.push({ id: `port-raw-${f.name}-${i}`, level: p.raw.includes("$") || /-/.test(p.raw) ? "info" : "error", message: p.raw.includes("$") || /-/.test(p.raw) ? `“${f.name}” publishes ${p.raw}; edit it in Compose.` : `“${f.name}”: “${p.raw}” isn't a port mapping. Use 8080:80 or 8080:80/udp.`, line, field: `${field("ports")}.${i}` });
        return;
      }
      if (f.hostNetwork) {
        issues.push({ id: `port-host-${f.name}-${i}`, level: "info", message: `“${f.name}” uses the server's network, so its ports mappings are ignored.`, line, field: `${field("ports")}.${i}` });
        return;
      }
      if (!p.host) return;
      const key = `${p.host}/${p.proto}`;
      const other = hostPorts.get(key);
      if (other) issues.push({ id: `port-dup-${f.name}-${i}`, level: "error", message: `Port ${p.host}${p.proto === "udp" ? "/udp" : ""} is published twice (${other} and ${f.name}).`, line, field: `${field("ports")}.${i}` });
      hostPorts.set(key, f.name);
      if (umbrel && ctx.web.service && ctx.web.port === p.host && p.proto === "tcp" && !forms.find((x) => x.name === ctx.web.service)?.hostNetwork) {
        issues.push({ id: `port-proxy-${f.name}-${i}`, level: "error", message: `Port ${p.host} is where Umbrel opens the app, and “${f.name}” also publishes it. Umbrel's proxy needs it to itself.`, line, field: `${field("ports")}.${i}`, fix: { id: `rm-port:${f.name}:${i}`, label: "Let Umbrel's proxy use it" } });
      }
    });

    // volumes
    const volSeq = node.get("volumes", true);
    f.volumes.forEach((v, i) => {
      const line = lineOf(isSeq(volSeq) ? volSeq.items[i] : undefined, lines);
      const vf = `${field("volumes")}.${i}`;
      if (v.kind === "named") {
        const decl = namedDecl.get(v.source);
        if (decl && (decl.driver || decl.driver_opts || decl.external)) {
          issues.push({ id: `vol-driver-${f.name}-${i}`, level: umbrel ? "error" : "info", message: `“${f.name}” uses the volume “${v.source}” with its own driver${umbrel ? "; Umbrel can't create it. Mount a folder instead" : ""}.`, line, field: vf });
        } else {
          issues.push({ id: `vol-named-${f.name}-${i}`, level: umbrel ? "warning" : "info", message: `“${f.name}” keeps ${v.target} in a Docker volume. Put it in the app's data folder so it's backed up and removed with the app.`, line, field: vf, fix: { id: `data-vol:${f.name}:${i}`, label: mediaKind(v.target) ? "Choose a server folder" : `Use data/${v.source}` } });
        }
      } else if (v.kind === "relative") {
        issues.push({ id: `vol-rel-${f.name}-${i}`, level: "error", message: `“${f.name}” mounts ${v.source}, a path relative to where the file was. It won't exist on the server.`, line, field: vf, fix: { id: `data-vol:${f.name}:${i}`, label: mediaKind(v.target) ? "Choose a server folder" : `Use data/${relName(v.source)}` } });
      } else if (v.kind === "host") {
        const e = hostPathError(v.source);
        if (e) issues.push({ id: `vol-host-${f.name}-${i}`, level: "error", message: `“${f.name}”: ${e}`, line, field: vf });
        else if (v.source === "/var/run/docker.sock" || v.source === "/run/docker.sock") issues.push({ id: `vol-sock-${f.name}-${i}`, level: "warning", message: `“${f.name}” gets Docker's socket, which lets it control every container on this server.`, line, field: vf });
        else if (SENSITIVE_HOST.some((re) => re.test(v.source))) issues.push({ id: `vol-sens-${f.name}-${i}`, level: "warning", message: `“${f.name}” mounts ${v.source}${v.readOnly ? " (read-only)" : ""}, a system folder of this server.`, line, field: vf });
      } else if (v.kind === "data") {
        const e = dataFolderError(v.source);
        if (e) issues.push({ id: `vol-data-${f.name}-${i}`, level: "error", message: `“${f.name}”: ${e}`, line, field: vf });
      } else if (v.raw && !v.long) {
        issues.push({ id: `vol-other-${f.name}-${i}`, level: "info", message: `“${f.name}” mounts “${v.raw}”; edit it in Compose.`, line, field: vf });
      }
      if (v.kind !== "other") {
        const te = containerPathError(v.target);
        if (te) issues.push({ id: `vol-target-${f.name}-${i}`, level: "error", message: `“${f.name}”: ${te}`, line, field: vf });
      }
      if (v.long && umbrel && v.kind !== "other") issues.push({ id: `vol-long-${f.name}-${i}`, level: "error", message: `“${f.name}” writes a volume in the long form. Umbrel only understands source:target strings.`, line, field: vf, fix: { id: `short-vol:${f.name}:${i}`, label: "Use the short form" } });
      else if (v.long && umbrel) issues.push({ id: `vol-long-${f.name}-${i}`, level: "error", message: `“${f.name}” has a ${v.raw?.includes("tmpfs") ? "tmpfs " : ""}volume Umbrel can't read. Rewrite it as source:target.`, line, field: vf });
    });

    for (const t of f.pendingFolders) {
      issues.push({ id: `vol-pending-${f.name}-${t}`, level: "error", message: `Choose a folder for ${t}${forms.length > 1 ? ` (“${f.name}”)` : ""}.`, line: at(PENDING_KEY), field: `${field("volumes")}.pending` });
    }

    // environment
    const secrets = secretSet(f.name);
    const seen = new Set<string>();
    f.env.forEach((e, i) => {
      const ef = `${field("env")}.${i}`;
      const ref = e.interpolated ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(e.value.trim()) : null;
      if (ref && !(umbrel ? UMBREL_VARS : COMPOSE_VARS).has(ref[1]!)) {
        fromEnv.add(ref[1]!);
        const secret = looksSecret(e.key) || looksSecret(ref[1]!);
        issues.push({
          id: `env-ref-${f.name}-${i}`,
          level: "warning",
          message: `“${f.name}”: ${e.key} comes from \${${ref[1]}}, which nothing sets here (it was probably in a .env file).`,
          line: at("environment"),
          field: ef,
          fix: { id: `env-ref:${f.name}:${e.key}:${secret ? "secret" : "plain"}`, label: secret ? "Enter it as a secret" : "Enter a value" },
        });
      }
      const ne = envNameError(e.key);
      if (ne) issues.push({ id: `env-name-${f.name}-${i}`, level: "error", message: `“${f.name}”, ${e.key || "a variable"}: ${ne}`, line: at("environment"), field: ef });
      const ve = envValueError(e.value);
      if (ve) issues.push({ id: `env-val-${f.name}-${i}`, level: "error", message: `“${f.name}”, ${e.key}: ${ve}`, line: at("environment"), field: ef });
      if (seen.has(e.key)) issues.push({ id: `env-dup-${f.name}-${i}`, level: "error", message: `“${f.name}” sets ${e.key} twice.`, line: at("environment"), field: ef });
      if (secrets.has(e.key)) issues.push({ id: `env-secret-dup-${f.name}-${i}`, level: "error", message: `“${f.name}” has ${e.key} both as a secret and in the file. Keep one.`, field: ef });
      seen.add(e.key);
    });

    f.devices.forEach((d, i) => {
      if (!DEVICE_RE.test(d)) issues.push({ id: `dev-${f.name}-${i}`, level: "error", message: `“${f.name}”: “${d}” isn't a device path like /dev/dri.`, line: at("devices"), field: `${field("devices")}.${i}` });
    });
    const me = memoryError(f.memory);
    if (me) issues.push({ id: `mem-${f.name}`, level: "error", message: `“${f.name}”: ${me}`, line: at("mem_limit"), field: field("memory") });
    const ce = cpusError(f.cpus);
    if (ce) issues.push({ id: `cpus-${f.name}`, level: "error", message: `“${f.name}”, CPU limit: ${ce}`, line: at("cpus"), field: field("cpus") });
    if (f.health) {
      for (const [k, label, yamlKey] of [["interval", "how often", "interval"], ["timeout", "the timeout", "timeout"], ["startPeriod", "the start period", "start_period"]] as const) {
        const de = durationError(f.health[k]);
        if (de) issues.push({ id: `health-${k}-${f.name}`, level: "error", message: `“${f.name}”, health check ${label}: ${de}`, line: at("healthcheck"), field: field(`health.${yamlKey}`) });
      }
      if (f.health.retries && !/^\d+$/.test(f.health.retries.trim())) issues.push({ id: `health-retries-${f.name}`, level: "error", message: `“${f.name}”: health check tries is a whole number, like 3.`, line: at("healthcheck"), field: field("health.retries") });
    }
    f.labels.forEach((l, i) => {
      const le = labelKeyError(l.key);
      if (le) issues.push({ id: `label-${f.name}-${i}`, level: "error", message: `“${f.name}”, label ${l.key || i + 1}: ${le}`, line: at("labels"), field: `${field("labels")}.${i}` });
    });
    if (!umbrel && !f.hostNetwork) {
      for (const net of f.networks) {
        if (net === "default") continue;
        const ne = networkNameError(net);
        if (ne) issues.push({ id: `net-name-${f.name}-${net}`, level: "error", message: `“${f.name}”, network “${net}”: ${ne}`, line: at("networks"), field: field("networks") });
        else if (!declaredNets.has(net)) issues.push({ id: `net-undeclared-${f.name}-${net}`, level: "error", message: `“${f.name}” joins the network “${net}”, which isn't declared under networks:.`, line: at("networks"), field: field("networks"), fix: { id: `declare-net:${net}`, label: "Join it as an existing network" } });
      }
    }
    if (f.gpu && f.devices.some((d) => d.startsWith("/dev/nvidia"))) {
      issues.push({ id: `gpu-dev-${f.name}`, level: "info", message: `“${f.name}” reserves the NVIDIA GPU and also lists /dev/nvidia devices; the reservation alone is enough.`, line: at("devices"), field: field("devices") });
    }
    for (const d of f.dependsOn) {
      if (!names.includes(d)) issues.push({ id: `dep-${f.name}-${d}`, level: "error", message: `“${f.name}” waits for “${d}”, which isn't a service here.`, line: at("depends_on"), field: field("dependsOn") });
      if (d === f.name) issues.push({ id: `dep-self-${f.name}`, level: "error", message: `“${f.name}” can't wait for itself.`, line: at("depends_on"), field: field("dependsOn") });
    }
  }
  for (const svc of Object.keys(ctx.secrets)) {
    if ((ctx.secrets[svc]?.length ?? 0) > 0 && !names.includes(svc)) issues.push({ id: `secret-orphan-${svc}`, level: "warning", message: `Secret variables are saved for “${svc}”, which isn't a service any more. They won't be used.` });
  }

  // ------------------------------------------------ web page
  const w = ctx.web;
  if (w.service) {
    const svc = forms.find((f) => f.name === w.service);
    if (!svc) issues.push({ id: "web-service", level: "error", message: `The web page is set to “${w.service}”, which isn't a service.`, field: "web.service" });
    const cp = portError(w.containerPort, "The app's own port");
    if (cp) issues.push({ id: "web-cport", level: "error", message: cp, field: "web.containerPort" });
    const pp = portError(w.port, "The port it opens on");
    if (pp) issues.push({ id: "web-port", level: "error", message: pp, field: "web.port" });
    if (svc?.hostNetwork && w.port && w.containerPort && w.port !== w.containerPort) {
      issues.push({ id: "web-hostnet", level: "error", message: `“${svc.name}” uses the server's network, so it opens on its own port ${w.containerPort}.`, field: "web.port" });
    }
    if (w.path && !w.path.startsWith("/")) issues.push({ id: "web-path", level: "error", message: "The path starts with /, like /admin.", field: "web.path" });
  } else if (umbrel) {
    issues.push({ id: "web-none", level: "info", message: "The app has no web page, so its tile in Umbrel won't open anything.", field: "web.service" });
  }

  // ------------------------------------------------ variables
  const known = umbrel ? UMBREL_VARS : COMPOSE_VARS;
  for (const v of variablesIn(text)) {
    if (known.has(v.name) || v.hasDefault || fromEnv.has(v.name)) continue;
    const line = lineAt(text, `\${${v.name}`) ?? lineAt(text, `$${v.name}`);
    issues.push({ id: `var-${v.name}`, level: "warning", message: `${line ? `Line ${line}: ` : ""}\${${v.name}} isn't set anywhere, so it will be empty.${umbrel ? "" : " (APP_DATA_DIR and APP_ID are.)"}`, line });
  }
  if (umbrel) {
    for (const v of ["APP_PASSWORD", "APP_SEED"]) if (variablesIn(text).some((x) => x.name === v)) issues.push({ id: `var-umbrel-${v}`, level: "info", message: `\${${v}} comes from Umbrel, so this app only works installed through Umbrel.` });
  }

  return { parsed, services: forms, issues };
}

const relName = (p: string) =>
  p
    .replace(/^\.?\/?/, "")
    .replace(/^~\/?/, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/(^|\/)\.+/g, "$1")
    .replace(/\/+$/, "") || "files";

// ---------------------------------------------------------------- fixes

export interface FixResult {
  text: string;
  web?: Partial<WebSettings>;
  /** Variables to add as secrets (empty values the person fills in). */
  secrets?: SecretNames;
  /** What it did, in words. */
  said: string;
}

/** Apply one fix to the compose text. Returns null when the fix no longer applies. */
export function applyFix(text: string, fixId: string, ctx: AnalyzeContext): FixResult | null {
  const parsed = parseCompose(text);
  if (!parsed.ok) return null;
  const doc = parsed.doc;
  const [kind, svc, idxStr, extra] = fixId.split(":");
  const idx = Number(idxStr);
  const done = (said: string, web?: Partial<WebSettings>): FixResult => ({ text: stringify(doc), said, web });
  switch (kind) {
    case "env-ref": {
      const f = readService(doc, svc!);
      const key = idxStr!;
      if (!f.env.some((e) => e.key === key)) return null;
      if (extra === "secret") {
        setEnv(doc, svc!, f.env.filter((e) => e.key !== key));
        return { text: stringify(doc), said: `${key} of “${svc}” is now a secret; enter its value.`, secrets: { [svc!]: [key] } };
      }
      setEnv(doc, svc!, f.env.map((e) => (e.key === key ? { key, value: "", interpolated: false } : e)));
      return done(`${key} of “${svc}” is now empty; enter its value.`);
    }
    case "declare-net": {
      // fixId is declare-net:<name>, so the name arrives where the service usually sits.
      const net = svc!;
      if (readNetworks(doc).some((n) => n.name === net)) return null;
      declareNetwork(doc, net, true);
      return done(`“${net}” is joined as an existing network on this server.`);
    }
    case "rm-version":
      doc.delete("version");
      return done("Removed version:.");
    case "rm-name":
      doc.delete("name");
      return done("Removed name:.");
    case "rm-networks": {
      for (const n of serviceNames(doc)) {
        const node = serviceNode(doc, n);
        if (node && scalarText(node.get("network_mode", true)) !== "host") node.delete("networks");
      }
      doc.delete("networks");
      return done("Removed custom networks.");
    }
    case "rm-profiles":
      serviceNode(doc, svc!)?.delete("profiles");
      return done(`“${svc}” always starts now.`);
    case "rm-envfile":
      serviceNode(doc, svc!)?.delete("env_file");
      return done(`Removed env_file from “${svc}”.`);
    case "rm-container-name":
      serviceNode(doc, svc!)?.delete("container_name");
      return done(`“${svc}” no longer has a fixed container name.`);
    case "rm-port": {
      const f = readService(doc, svc!);
      const p = f.ports[idx];
      if (!p) return null;
      setPorts(doc, svc!, f.ports.filter((_, i) => i !== idx));
      return done(`Umbrel's proxy now serves port ${p.host}; “${svc}” no longer publishes it.`);
    }
    case "data-vol": {
      const f = readService(doc, svc!);
      const v = f.volumes[idx];
      if (!v || (v.kind !== "named" && v.kind !== "relative")) return null;
      const media = mediaKind(v.target);
      if (media) {
        // A media library never goes in app data (it's deleted with the app): wait for a server folder.
        setVolumes(doc, svc!, f.volumes.filter((_, i) => i !== idx));
        setPendingFolders(doc, svc!, [...f.pendingFolders, v.target]);
        if (v.kind === "named") dropUnusedVolumes(doc);
        return done(`Choose a server folder for ${v.target} of “${svc}”: it holds your ${media}, so it isn't kept with the app.`);
      }
      const folder = v.kind === "named" ? v.source : relName(v.source);
      const rows: VolumeRow[] = f.volumes.map((r, i) => (i === idx ? { kind: "data", source: folder, target: r.target, readOnly: r.readOnly, raw: null, long: false } : r));
      setVolumes(doc, svc!, rows);
      if (v.kind === "named") dropUnusedVolumes(doc);
      return done(`“${svc}” keeps ${v.target} in ${DATA_PREFIX.replace("${APP_DATA_DIR}/", "")}${folder}.`);
    }
    case "short-vol": {
      const f = readService(doc, svc!);
      const v = f.volumes[idx];
      if (!v || !v.long || v.kind === "other") return null;
      setVolumes(doc, svc!, f.volumes.map((r, i) => (i === idx ? { ...r, long: false, raw: null } : r)));
      return done(`Rewrote a volume of “${svc}” in the short form.`);
    }
    case "app-proxy": {
      const proxy = serviceNode(doc, "app_proxy");
      if (!proxy) return null;
      const env = nodeJs<{ environment?: Record<string, unknown> | string[] }>(proxy, doc).environment;
      const get = (k: string) => {
        if (Array.isArray(env)) return env.map(String).find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1);
        const v = env?.[k];
        return v === undefined || v === null ? undefined : String(v);
      };
      const host = (get("APP_HOST") ?? "").trim();
      const port = Number(get("APP_PORT"));
      const auth = (get("PROXY_AUTH_ADD") ?? "true").toLowerCase() !== "false";
      servicesMap(doc)!.delete("app_proxy");
      const names = serviceNames(doc);
      const service =
        names.find((n) => n === host) ??
        names.find((n) => new RegExp(`_${n}_\\d+$`).test(host) || host.endsWith(`-${n}-1`)) ??
        names.find((n) => readService(doc, n).containerName === host) ??
        (names.length === 1 ? names[0]! : null);
      return done(service ? `The web page is “${service}” on port ${Number.isFinite(port) ? port : "?"}.` : "Removed app_proxy. Choose the web page's service under Web page.", {
        service,
        containerPort: Number.isFinite(port) && port > 0 ? port : null,
        umbrelAuth: auth,
      });
    }
  }
  return null;
}

function dropUnusedVolumes(doc: Document) {
  const top = doc.get("volumes", true);
  if (!isMap(top)) return;
  const used = new Set<string>();
  for (const n of serviceNames(doc)) for (const v of readService(doc, n).volumes) if (v.kind === "named") used.add(v.source);
  for (const p of [...top.items]) {
    const k = scalarText(p.key) ?? "";
    if (!used.has(k)) top.delete(k);
  }
  if (top.items.length === 0) doc.delete("volumes");
}

/** Apply every fix that has one, repeatedly (fixes can reveal others). */
/** Fixes "Fix all" makes. Container names stay: some apps are reached by them on purpose. */
export const autoFixable = (i: Issue) => !!i.fix && !i.fix.id.startsWith("rm-container-name");

/** Apply every fix that has one, repeatedly (fixes can reveal others). */
export function applyAllFixes(text: string, ctx: AnalyzeContext, only: (i: Issue) => boolean = autoFixable): { text: string; web: Partial<WebSettings>; secrets: SecretNames; said: string[] } {
  let cur = text;
  let web: Partial<WebSettings> = {};
  const secrets: SecretNames = {};
  const said: string[] = [];
  const tried = new Set<string>();
  for (let round = 0; round < 60; round++) {
    const c = { ...ctx, web: { ...ctx.web, ...web }, secrets: mergeSecrets(ctx.secrets, secrets) };
    const next = analyze(cur, c).issues.find((i) => i.fix && only(i) && !tried.has(i.fix.id));
    if (!next?.fix) break;
    tried.add(next.fix.id);
    const r = applyFix(cur, next.fix.id, c);
    if (!r) continue;
    cur = r.text;
    web = { ...web, ...r.web };
    for (const [svc, keys] of Object.entries(r.secrets ?? {})) secrets[svc] = [...new Set([...(secrets[svc] ?? []), ...keys])];
    said.push(r.said);
    tried.clear();
  }
  return { text: cur, web, secrets, said };
}

export function mergeSecrets(a: SecretNames, b: SecretNames): SecretNames {
  const out: SecretNames = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = [...new Set([...(out[k] ?? []), ...v])];
  return out;
}

/** Details and web settings, for fields outside the compose file. */
export function detailIssues(spec: AppSpec, published: boolean): Issue[] {
  const d = spec.details;
  const out: Issue[] = [];
  const add = (field: string, message: string | null, level: Issue["level"] = "error") => message && out.push({ id: `details-${field}`, level, message, field: `details.${field}` });
  add("name", nameError(d.name));
  if (!published) add("slug", slugError(d.slug));
  add("tagline", taglineError(d.tagline));
  add("icon", iconError(d.icon));
  add("website", urlError(d.website, "website"));
  add("support", urlError(d.support, "support address"));
  if (!d.version.trim()) add("version", "Give it a version, like 1.0.0.");
  else if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(d.version.trim())) add("version", "Use letters, digits, dots and dashes, like 1.4.2.");
  if (d.description.length > 5000) add("description", "Keep the description under 5,000 characters.");
  if (d.releaseNotes.length > 2000) add("releaseNotes", "Keep the release notes under 2,000 characters.");
  return out;
}

export const blocking = (issues: Issue[]) => issues.filter((i) => i.level === "error");
