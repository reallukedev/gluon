// Starts Gluon for the E2E suite against a fresh, empty data directory.
// Default: a production build (stable while files change, and what people run).
// E2E_DEV=1 uses `next dev` instead; E2E_SKIP_BUILD=1 reuses the last build.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = process.env.E2E_PORT ?? "8131";
const data = process.env.GLUON_E2E_DATA;
if (!data) throw new Error("GLUON_E2E_DATA is not set; run through playwright.config.ts");

rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });

const env = { ...process.env, GLUON_DATA: data, GLUON_NO_NSENTER: "1", PORT: port, HOSTNAME: "127.0.0.1" };
const next = join(root, "node_modules", ".bin", "next");

let child;
if (process.env.E2E_DEV === "1") {
  child = spawn(next, ["dev", "-p", port, "-H", "127.0.0.1"], { cwd: root, env, stdio: "inherit" });
} else {
  const standalone = join(root, ".next", "standalone");
  if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(join(standalone, "server.js"))) {
    const build = spawnSync(next, ["build"], { cwd: root, env: { ...process.env }, stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  // The standalone server does not serve static assets unless they are copied next to it.
  cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
  if (existsSync(join(root, "public"))) cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
  child = spawn(process.execPath, [join(standalone, "server.js")], { cwd: standalone, env, stdio: "inherit" });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
