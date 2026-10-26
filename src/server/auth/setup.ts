import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../db";
import { safeEqual } from "../crypto";
import { userCount } from "./users";

const FILE = () => path.join(DATA_DIR, "setup-code");

/**
 * First-run protection. Until an admin exists, creating one requires a code that is only visible
 * to someone with access to the server (container log / data volume). Stops a stranger who reaches
 * the public address first from claiming the server.
 */
export function ensureSetupCode(): string | null {
  if (userCount() > 0) {
    try {
      fs.unlinkSync(FILE());
    } catch {
      /* none */
    }
    return null;
  }
  let code: string;
  try {
    code = fs.readFileSync(FILE(), "utf8").trim();
  } catch {
    const raw = crypto.randomBytes(6).toString("hex").toUpperCase();
    code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE(), code, { mode: 0o600 });
  }
  const line = "─".repeat(52);
  console.log(`\n${line}\n  Gluon is ready for first-time setup.\n  Setup code: ${code}\n  Open Gluon in a browser and enter this code to\n  create the first admin account.\n${line}\n`);
  return code;
}

export function checkSetupCode(input: string): boolean {
  try {
    const code = fs.readFileSync(FILE(), "utf8").trim();
    return safeEqual(code.replace(/-/g, "").toUpperCase(), input.replace(/[\s-]/g, "").toUpperCase());
  } catch {
    return false;
  }
}

export function clearSetupCode() {
  try {
    fs.unlinkSync(FILE());
  } catch {
    /* none */
  }
}
