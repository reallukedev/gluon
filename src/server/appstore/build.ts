import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lineReader } from "../host/exec";
import { AppError } from "../errors";
import { docker } from "../docker/client";
import { STORE_DIR } from "./repo";
import { cloneRepo, cloneUrl } from "./github";
import { finishBuild, startBuild, type AppRow } from "./db";
import { parseCompose, readService, serviceNames } from "@/lib/builder/compose";
import { LOCAL_REGISTRY } from "@/lib/builder/names";

/**
 * Builds a GitHub app's images on this server. The repository is shallow-cloned inside Gluon's
 * container; each build context is streamed as a tar into the host's `docker build -` (BuildKit),
 * so the host needs nothing but Docker. Images are tagged gluon.local/<app>[-<service>]:<commit>:
 * the made-up registry host means a missing image can never be fetched from Docker Hub instead.
 */

const WORK = path.join(STORE_DIR, "work");
const NSENTER = ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

export function imageName(slug: string, service: string) {
  const svc = service.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${LOCAL_REGISTRY}/${svc === slug || !svc ? slug : `${slug}-${svc}`}`;
}

/** Services that build from the repository. */
export function buildServices(compose: string): { service: string; context: string; dockerfile: string; target: string }[] {
  const p = parseCompose(compose);
  if (!p.ok) return [];
  return serviceNames(p.doc)
    .map((n) => ({ n, f: readService(p.doc, n) }))
    .filter((x) => x.f.build)
    .map((x) => ({ service: x.n, context: x.f.build!.context || ".", dockerfile: x.f.build!.dockerfile || "Dockerfile", target: x.f.build!.target }));
}

/** Do the images a version was published with still exist on this server? */
export async function imagesPresent(images: Record<string, string>): Promise<boolean> {
  for (const tag of Object.values(images)) {
    try {
      await docker().getImage(tag).inspect();
    } catch {
      return false;
    }
  }
  return true;
}

function within(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

interface BuildResult {
  commit: string;
  images: Record<string, string>;
}

/**
 * Clone and build every service with build:. Streams output through onLine; records the build
 * (log kept for later) whatever happens.
 */
export async function buildApp(
  app: AppRow,
  token: string | undefined,
  user: { id: string; username: string } | null,
  onLine: (text: string, stream?: "out" | "err") => void,
  onStep: (text: string) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const gh = app.github;
  if (!gh) throw new AppError("no_repo", "This app isn't from a repository.");
  const services = buildServices(app.spec.compose);
  if (!services.length) throw new AppError("nothing_to_build", "No service in this app builds from the repository.");
  const bid = startBuild(app.id, user);
  const log: string[] = [];
  const say = (t: string, s: "out" | "err" = "out") => {
    log.push(t);
    if (log.length > 20_000) log.splice(0, log.length - 20_000);
    onLine(t, s);
  };
  const dir = path.join(WORK, `${app.id}-${crypto.randomBytes(4).toString("hex")}`);
  let commit: string | null = null;
  const images: Record<string, string> = {};
  try {
    onStep(`Cloning ${gh.owner}/${gh.repo}`);
    commit = await cloneRepo(gh, token, dir, (l) => say(l));
    const root = path.join(dir, gh.path || ".");
    if (!within(root, dir) || !fs.existsSync(root)) throw new AppError("github_path", `The folder “${gh.path}” isn't in this commit any more.`, 404);
    for (const s of services) {
      if (signal?.aborted) throw new AppError("cancelled", "The build was stopped.", 409);
      const ctx = path.resolve(root, s.context);
      if (!within(ctx, dir) || !fs.existsSync(ctx) || !fs.statSync(ctx).isDirectory()) throw new AppError("build_context", `“${s.service}” builds from “${s.context}”, which isn't a folder in the repository.`, 400);
      const df = path.resolve(ctx, s.dockerfile);
      if (!within(df, ctx) || !fs.existsSync(df)) throw new AppError("build_dockerfile", `“${s.service}” needs ${s.dockerfile}, which isn't in “${s.context}”.`, 400);
      const tag = `${imageName(app.slug, s.service)}:${commit.slice(0, 12)}`;
      onStep(`Building ${s.service}`);
      say(`$ docker build -t ${tag} -f ${path.relative(ctx, df)}${s.target ? ` --target ${s.target}` : ""} (context: ${path.relative(dir, ctx) || "."})`);
      const code = await dockerBuild(ctx, path.relative(ctx, df), tag, s.target, { app: app.id, commit, source: cloneUrl(gh) }, say, signal);
      if (code !== 0) throw new AppError("build_failed", `Building “${s.service}” failed. The log above shows why.`, 500);
      images[s.service] = tag;
    }
    finishBuild(bid, { status: "ok", commit, images, log: log.join("\n"), error: null });
    return { commit, images };
  } catch (e) {
    const message = e instanceof AppError ? e.message : "The build stopped unexpectedly.";
    if (!(e instanceof AppError)) console.error("[gluon] build failed", e);
    finishBuild(bid, { status: "failed", commit, images, log: log.join("\n"), error: message });
    throw e instanceof AppError ? e : new AppError("build_failed", message, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function dockerBuild(
  ctx: string,
  dockerfile: string,
  tag: string,
  target: string,
  labels: { app: string; commit: string; source: string },
  say: (t: string, s?: "out" | "err") => void,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      "build", "--progress=plain", "-t", tag, "-f", dockerfile,
      "--label", `app.gluon.builder=${labels.app}`,
      "--label", `org.opencontainers.image.revision=${labels.commit}`,
      "--label", `org.opencontainers.image.source=${labels.source}`,
      ...(target ? ["--target", target] : []),
      "-",
    ];
    const direct = (process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1";
    const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" } as unknown as NodeJS.ProcessEnv;
    const build = direct ? spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"] }) : spawn("nsenter", [...NSENTER, "docker", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const tar = spawn("tar", ["-C", ctx, "-cf", "-", "--exclude=./.git", "."], { stdio: ["ignore", "pipe", "pipe"] });
    tar.stdout.pipe(build.stdin);
    build.stdin.on("error", () => undefined);
    tar.stderr.on("data", (d) => say(d.toString().trim(), "err"));
    const out = lineReader((l) => say(l, "out"));
    const err = lineReader((l) => say(l, "out")); // BuildKit writes progress to stderr; it isn't an error
    build.stdout.on("data", (d) => out.push(d));
    build.stderr.on("data", (d) => err.push(d));
    const timer = setTimeout(() => {
      say("The build took over an hour and was stopped.", "err");
      build.kill("SIGKILL");
      tar.kill("SIGKILL");
    }, 60 * 60_000);
    const abort = () => {
      build.kill("SIGTERM");
      tar.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort);
    build.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      out.flush();
      err.flush();
      resolve(code ?? 1);
    });
    build.on("error", () => resolve(1));
  });
}

/** Remove this app's older images (found by their builder label), keeping the given tags. */
export async function pruneImages(appId: string, keep: string[]) {
  try {
    const list = await docker().listImages({ filters: { label: [`app.gluon.builder=${appId}`] } });
    for (const img of list) {
      const tags = img.RepoTags ?? [];
      if (tags.some((t) => keep.includes(t))) continue;
      for (const t of tags) await docker().getImage(t).remove().catch(() => undefined);
    }
  } catch {
    /* best effort */
  }
}
