import fs from "node:fs";
import path from "node:path";
import { route } from "@/server/api";
import { DATA_DIR } from "@/server/db";
import pkg from "../../../../package.json";

export const GET = route({ auth: "admin" }, () => {
  let dbSize = 0;
  for (const f of ["gluon.db", "gluon.db-wal"]) {
    try {
      dbSize += fs.statSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ DATA_DIR, f)).size;
    } catch {
      /* missing */
    }
  }
  return {
    version: pkg.version,
    node: process.version,
    next: pkg.dependencies.next,
    dataDir: DATA_DIR,
    dbSize,
    startedAt: Date.now() - process.uptime() * 1000,
    mode: process.env.NODE_ENV,
  };
});
