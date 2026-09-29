import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../db";
import { local, CommandError } from "../host/exec";
import { AppError } from "../errors";

/**
 * Gluon's Umbrel app store: a bare git repository in Gluon's data folder. Commits are made with
 * git's plumbing from a freshly written tree each time (no working copy to drift), and `main` is
 * moved with a compare-and-swap update-ref, so a reader (Umbrel cloning over HTTP) always sees a
 * whole commit.
 */

export const STORE_DIR = path.join(DATA_DIR, "appstore");
export const REPO_NAME = "store.git";
export const REPO_DIR = path.join(STORE_DIR, REPO_NAME);
const BRANCH = "refs/heads/main";

export const GIT_ENV: Record<string, string> = {
  HOME: STORE_DIR,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Gluon",
  GIT_AUTHOR_EMAIL: "gluon@localhost",
  GIT_COMMITTER_NAME: "Gluon",
  GIT_COMMITTER_EMAIL: "gluon@localhost",
};

type G = typeof globalThis & { __gluonGit?: boolean | null; __gluonStoreLock?: Promise<unknown> };
const g = globalThis as G;

/** Is git in this image? (Gluon's Dockerfile installs it; older images may not have it.) */
export async function gitAvailable(): Promise<boolean> {
  if (g.__gluonGit != null) return g.__gluonGit;
  g.__gluonGit = await local("git", ["--version"], { timeoutMs: 5000 })
    .then(() => true)
    .catch(() => false);
  return g.__gluonGit;
}

export function git(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; input?: string; cwd?: string; okCodes?: number[] } = {}) {
  return local("git", args, { timeoutMs: opts.timeoutMs ?? 60_000, env: { ...GIT_ENV, ...opts.env }, input: opts.input, cwd: opts.cwd, okCodes: opts.okCodes });
}

/** One writer at a time: commits and Umbrel refreshes run in order. */
export async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__gluonStoreLock ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  g.__gluonStoreLock = prev.catch(() => undefined).then(() => mine);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function ensureRepo(storeId: string, storeName: string) {
  if (!(await gitAvailable())) throw new AppError("git_missing", "Gluon's image doesn't include git, which the app store needs. Update Gluon to a newer image.", 500);
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(REPO_DIR, "HEAD"))) {
    await git(["init", "--bare", "--quiet", "--initial-branch=main", REPO_DIR]);
    // Read-only over HTTP: never accept pushes, whatever else is configured.
    await git(["--git-dir", REPO_DIR, "config", "http.receivepack", "false"]);
    await git(["--git-dir", REPO_DIR, "config", "http.uploadpack", "true"]);
    await git(["--git-dir", REPO_DIR, "config", "uploadpack.allowAnySHA1InWant", "false"]);
  }
  if (!(await headCommit())) await commitStore(storeId, storeName, {}, "Start Gluon's app store");
}

export async function headCommit(): Promise<string | null> {
  if (!fs.existsSync(path.join(REPO_DIR, "HEAD"))) return null;
  const r = await git(["--git-dir", REPO_DIR, "rev-parse", "--verify", "--quiet", `${BRANCH}^{commit}`], { okCodes: [1] });
  return r.stdout.trim() || null;
}

const SAFE_PATH = /^(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+)*$/;

/**
 * Write the whole store (every app folder) as the next commit. Returns the commit; when nothing
 * changed, the current one.
 */
export async function commitStore(storeId: string, storeName: string, apps: Record<string, Record<string, string>>, message: string): Promise<string> {
  const stage = path.join(STORE_DIR, `.stage-${crypto.randomBytes(6).toString("hex")}`);
  const index = `${stage}.index`;
  try {
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stage, "umbrel-app-store.yml"), `id: ${storeId}\nname: ${JSON.stringify(storeName)}\n`);
    fs.writeFileSync(path.join(stage, "README.md"), `# ${storeName}\n\nApps made with Gluon's app builder. Gluon writes this repository; changes made here by hand are replaced on the next publish.\n`);
    for (const [folder, files] of Object.entries(apps)) {
      if (!SAFE_PATH.test(folder) || folder.includes("/")) throw new Error(`Unsafe app folder ${folder}`);
      for (const [rel, content] of Object.entries(files)) {
        if (!SAFE_PATH.test(rel)) throw new Error(`Unsafe path ${rel}`);
        const file = path.join(stage, folder, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
    const env = { GIT_INDEX_FILE: index };
    await git(["--git-dir", REPO_DIR, "--work-tree", stage, "add", "--all", "--force", "."], { env, cwd: stage });
    const tree = (await git(["--git-dir", REPO_DIR, "write-tree"], { env })).stdout.trim();
    const parent = await headCommit();
    if (parent) {
      const parentTree = (await git(["--git-dir", REPO_DIR, "rev-parse", `${parent}^{tree}`])).stdout.trim();
      if (parentTree === tree) return parent;
    }
    const commit = (await git(["--git-dir", REPO_DIR, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message.slice(0, 500)])).stdout.trim();
    await git(["--git-dir", REPO_DIR, "update-ref", "-m", message.slice(0, 200), BRANCH, commit, ...(parent ? [parent] : ["0000000000000000000000000000000000000000"])]);
    await git(["--git-dir", REPO_DIR, "symbolic-ref", "HEAD", BRANCH]);
    // Loose objects pile up with every publish; let git pack them when it thinks it should.
    void git(["--git-dir", REPO_DIR, "gc", "--auto", "--quiet"], { timeoutMs: 120_000 }).catch(() => undefined);
    return commit;
  } catch (e) {
    if (e instanceof CommandError) throw new AppError("store_commit", `Gluon couldn't write its app store: ${e.message}`, 500);
    throw e;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(index, { force: true });
  }
}

/** Files of one app folder at the current commit (for checks and diffs). */
export async function storeFiles(folder: string): Promise<string[]> {
  const head = await headCommit();
  if (!head) return [];
  const r = await git(["--git-dir", REPO_DIR, "ls-tree", "-r", "--name-only", head, "--", folder], { okCodes: [128] });
  return r.stdout.split("\n").filter(Boolean);
}
