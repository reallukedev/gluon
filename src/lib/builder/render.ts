/**
 * Turns a custom app into the files that run it.
 *
 * Umbrel (an app folder in Gluon's store):
 *   umbrel-app.yml       the manifest Umbrel lists
 *   docker-compose.yml   the app, plus Umbrel's app_proxy for the web page
 *   data/<folder>/.gitkeep   so each data folder exists (owned by Umbrel's user) before first start
 * Umbrel pulls every `image:` from a registry, so a service Gluon built locally becomes a build whose
 * whole Dockerfile is `FROM gluon.local/<image>`: it resolves the local image, sends no build context,
 * and `compose pull` skips it. Updates copy docker-compose.yml, so this stays correct across versions.
 * Secrets never appear here: each service with secrets reads ${APP_DATA_DIR}/secrets/<service>.env,
 * which Gluon writes on the server next to the app.
 *
 * Compose (Gluon runs it itself when Umbrel isn't used): docker-compose.yml and a .env with
 * APP_DATA_DIR/APP_ID, in the app's own folder. Its name and icon go to Gluon's own app settings,
 * not into the file (x-casaos would make it look like a CasaOS app).
 */
import { Document, Scalar, isMap, isScalar, isSeq } from "yaml";
import type { AppSpec, BuilderTarget, SecretNames } from "@/lib/builder-types";
import { parseCompose, readService, scalarText, serviceNames, serviceNode } from "./compose";

export interface RenderInput {
  spec: AppSpec;
  target: BuilderTarget;
  /** Umbrel app id ("gluon-paperless") or compose project name ("paperless"). */
  appId: string;
  version: string;
  secrets: SecretNames;
  /** Service → image tag Gluon built for it (for services with build:). */
  images: Record<string, string>;
  /** Where people manage this app in Gluon (Umbrel's "submission" link). */
  gluonUrl: string;
  /** Repository page, for GitHub apps. */
  repoUrl?: string | null;
  /** Compose target: the app's folder on the server. */
  appDir?: string;
}

export interface Rendered {
  files: Record<string, string>;
  /** Folders under data/ the app uses. */
  dataFolders: string[];
  /** The container Umbrel's proxy forwards to. */
  proxyHost: string | null;
}

const HEADER = (name: string) =>
  `# ${name.replace(/\n/g, " ")}, made with Gluon's app builder.\n# Gluon rewrites this file whenever the app is published; edit the app in Gluon instead.\n`;

export const secretsPath = (service: string) => `\${APP_DATA_DIR}/secrets/${service}.env`;

export function renderApp(input: RenderInput): Rendered {
  const { spec, target, appId } = input;
  const parsed = parseCompose(spec.compose);
  if (!parsed.ok) throw new Error("The compose file has errors.");
  const src = parsed.doc;
  const doc = new Document(src.toJS() as object);
  const services = doc.get("services") as import("yaml").YAMLMap;
  doc.delete("version");
  doc.delete("name");

  const dataFolders = new Set<string>();
  for (const name of serviceNames(src)) {
    const form = readService(src, name);
    const node = serviceNode(doc, name)!;
    if (form.build) {
      const tag = input.images[name];
      if (!tag) throw new Error(`“${name}” hasn't been built yet.`);
      node.delete("build");
      if (target === "umbrel") {
        node.delete("image");
        node.set("build", doc.createNode({ context: "${APP_DATA_DIR}", dockerfile_inline: `FROM ${tag}\n` }));
      } else {
        node.set("image", tag);
        node.set("pull_policy", "never");
      }
    }
    if ((input.secrets[name]?.length ?? 0) > 0) {
      node.set("env_file", doc.createNode([{ path: secretsPath(name), required: false }]));
    }
    for (const v of form.volumes) {
      if (v.kind === "data") {
        const top = v.source.split("/")[0]!;
        // A single file (config.yml) would become a folder of that name; only pre-make folders.
        if (top && !/\.[A-Za-z0-9]{1,5}$/.test(top)) dataFolders.add(top);
      }
    }
  }

  let proxyHost: string | null = null;
  const web = spec.web;
  const webForm = web.service && serviceNames(src).includes(web.service) ? readService(src, web.service) : null;
  if (target === "umbrel" && webForm && !webForm.hostNetwork && web.containerPort) {
    proxyHost = webForm.containerName || `${appId}_${webForm.name}_1`;
    const env: Record<string, string | number> = { APP_HOST: proxyHost, APP_PORT: web.containerPort };
    if (!web.umbrelAuth) env.PROXY_AUTH_ADD = "false";
    // app_proxy goes first, the way Umbrel's own apps read.
    services.items.unshift(doc.createPair("app_proxy", { environment: env }));
  }
  if (target === "compose" && webForm && !webForm.hostNetwork && web.containerPort && web.port) {
    const node = serviceNode(doc, webForm.name)!;
    const has = webForm.ports.some((p) => p.host === web.port && p.proto === "tcp");
    if (!has) {
      const ports = node.get("ports", true);
      if (isSeq(ports)) ports.items.push(doc.createNode(`${web.port}:${web.containerPort}`));
      else node.set("ports", doc.createNode([`${web.port}:${web.containerPort}`]));
    }
  }

  // Port mappings are always strings: YAML 1.1 readers turn 22:22 into a base-60 number.
  for (const item of services.items) {
    const ports = isMap(item.value) ? item.value.get("ports", true) : null;
    if (isSeq(ports)) for (const p of ports.items) if (isScalar(p) && typeof p.value === "string") p.type = Scalar.QUOTE_DOUBLE;
  }

  const files: Record<string, string> = {};
  if (target === "umbrel") {
    doc.commentBefore = null;
    files["docker-compose.yml"] = HEADER(spec.details.name) + "\n" + doc.toString({ lineWidth: 0 });
    files["umbrel-app.yml"] = manifest(input, webForm?.hostNetwork ? web.containerPort : web.port);
    for (const f of dataFolders) files[`data/${f}/.gitkeep`] = "";
  } else {
    doc.set("name", appId);
    files["docker-compose.yml"] = HEADER(spec.details.name) + "\n" + doc.toString({ lineWidth: 0 });
    files[".env"] = `# Written by Gluon.\nAPP_DATA_DIR=${input.appDir ?? "."}\nAPP_ID=${appId}\n`;
  }
  return { files, dataFolders: [...dataFolders], proxyHost };
}

function manifest(input: RenderInput, port: number | null): string {
  const d = input.spec.details;
  const website = d.website.trim() || input.repoUrl || input.gluonUrl;
  const m: Record<string, unknown> = {
    manifestVersion: "1.1",
    id: input.appId,
    category: d.category || "other",
    name: d.name.trim(),
    version: input.version,
    tagline: d.tagline.trim() || d.name.trim(),
    description: d.description.trim() || d.tagline.trim() || `${d.name.trim()}, made with Gluon.`,
    releaseNotes: d.releaseNotes.trim(),
    developer: d.developer.trim() || "You",
    website,
    dependencies: [],
    repo: input.repoUrl ?? "",
    support: d.support.trim() || website,
    port: port ?? 0,
    gallery: [],
    path: input.spec.web.path || "",
    submitter: "Gluon",
    submission: input.gluonUrl,
  };
  if (d.icon) m.icon = d.icon;
  const doc = new Document(m);
  // Umbrel compares versions as strings; keep it a string even when it looks like a number.
  const v = doc.get("version", true);
  if (v && typeof v === "object" && "type" in v) (v as { type: string }).type = "QUOTE_DOUBLE";
  return `# Made with Gluon's app builder.\n${doc.toString({ lineWidth: 0 })}`;
}

/** The container names a rendered compose file will create (for conflict checks). */
export function containerNames(spec: AppSpec, appId: string, target: BuilderTarget): string[] {
  const parsed = parseCompose(spec.compose);
  if (!parsed.ok) return [];
  return serviceNames(parsed.doc).map((n) => {
    const node = serviceNode(parsed.doc, n);
    const fixed = node && isMap(node) ? scalarText(node.get("container_name", true)) : null;
    return fixed || (target === "umbrel" ? `${appId}_${n}_1` : `${appId}-${n}-1`);
  });
}

/**
 * One line per secret for a compose env file. Single quotes keep a value literal; values that
 * contain a quote or a newline use double quotes with \\, \", \n and \$ escaped (verified against
 * docker compose's env_file parser).
 */
export function envFile(values: Record<string, string>): string {
  const lines = ["# Written by Gluon. Secret values for this service; edit them in Gluon."];
  for (const [k, v] of Object.entries(values)) {
    if (!v.includes("'") && !v.includes("\n") && !v.includes("\r")) lines.push(`${k}='${v}'`);
    else lines.push(`${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\$/g, "\\$")}"`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The version the next publish gets: the person's label when it's new, else the last published
 * version bumped (1.0.3 → 1.0.4, 2.1-beta → 2.1-beta-2 → 2.1-beta-3). Umbrel offers an update
 * whenever the version string changes, so a republish must never reuse the last one. After a
 * publish the draft's label becomes the published version, so bumps carry on from there.
 */
export function nextVersion(label: string, last: string | null): string {
  const l = label.trim() || "1.0.0";
  if (!last || l !== last) return l;
  const numeric = /^(v?)(\d+(?:\.\d+)*)$/.exec(last);
  if (numeric) {
    const parts = numeric[2]!.split(".");
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return numeric[1] + parts.join(".");
  }
  const suffix = /^(.*)-(\d+)$/.exec(last);
  if (suffix && !/^\d+$/.test(suffix[1]!)) return `${suffix[1]}-${Number(suffix[2]) + 1}`;
  return `${last}-2`;
}
