import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../db";
import { safeEqual } from "../crypto";
import { userCount } from "./users";

const FILE = () => path.join(DATA_DIR, "setup-code");

/**
 * Until an admin exists, creating one needs a code only someone with access to the server can see
 * (container log or data volume), so a stranger who reaches the public address first can't claim it.
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
  let code = readCode();
  if (!code) {
    const raw = crypto.randomBytes(6).toString("hex").toUpperCase();
    code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Written whole or not at all: a half-written (empty) file must never become the code.
    const tmp = `${FILE()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, code, { mode: 0o600 });
    fs.renameSync(tmp, FILE());
  }
  const line = "─".repeat(52);
  console.log(`\n${line}\n  Gluon is ready for first-time setup.\n  Setup code: ${code}\n  Open Gluon in a browser and enter this code to\n  create the first admin account.\n${line}\n`);
  return code;
}

const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

/** null when it's too short to be one: an empty file would match an empty guess. */
function readCode(): string | null {
  try {
    const code = fs.readFileSync(FILE(), "utf8").trim();
    return norm(code).length >= 12 ? code : null;
  } catch {
    return null;
  }
}

export function checkSetupCode(input: string): boolean {
  const code = readCode();
  return !!code && safeEqual(norm(code), norm(input));
}

export function clearSetupCode() {
  try {
    fs.unlinkSync(FILE());
  } catch {
    /* none */
  }
}
