import "server-only";
import QRCode from "qrcode";
import { z } from "zod";
import { db, now, one, run } from "../db";
import { decrypt, encrypt } from "../crypto";
import { badRequest } from "../errors";
import type { GuestWifiData, WifiSecurity } from "@/lib/home-widgets-types";

/**
 * The household's guest network, entered once by an admin and shown to everyone as a scannable code. The password is
 * stored encrypted with the server key, like integration secrets.
 */

type G = typeof globalThis & { __gluonGuestWifiTable?: boolean };
const g = globalThis as G;

export function ensureGuestWifiTable() {
  if (g.__gluonGuestWifiTable) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS guest_wifi (
      id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, security TEXT NOT NULL, secret TEXT,
      hidden INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT
    );
  `);
  g.__gluonGuestWifiTable = true;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export const guestWifiSchema = z
  .object({
    ssid: z
      .string()
      .trim()
      .min(1, "Enter the network's name.")
      .refine((s) => bytes(s) <= 32, "Network names are at most 32 characters."),
    security: z.enum(["WPA", "WEP", "nopass"]),
    /** Leave out to keep the stored password. */
    password: z.string().max(128).optional(),
    hidden: z.boolean().default(false),
  })
  .strict();

function checkPassword(security: WifiSecurity, password: string) {
  if (security === "WPA") {
    const hex64 = /^[0-9a-f]{64}$/i.test(password);
    if (!hex64 && (password.length < 8 || password.length > 63)) throw badRequest("A WPA password is 8 to 63 characters.", { field: "password" });
  }
  if (security === "WEP" && ![5, 13].includes(password.length) && !/^([0-9a-f]{10}|[0-9a-f]{26})$/i.test(password)) {
    throw badRequest("A WEP key is 5 or 13 characters (or 10 or 26 hex digits).", { field: "password" });
  }
}

/** Escape per the Wi-Fi QR format: backslash before \ ; , : and ". */
const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");

export function wifiPayload(ssid: string, security: WifiSecurity, password: string | null, hidden: boolean): string {
  const parts = [`T:${security}`, `S:${esc(ssid)}`];
  if (security !== "nopass" && password) parts.push(`P:${esc(password)}`);
  if (hidden) parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

function matrix(text: string): { size: number; bits: string } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const { size, data } = qr.modules;
  let bits = "";
  for (let i = 0; i < size * size; i++) bits += data[i] ? "1" : "0";
  return { size, bits };
}

interface Row {
  ssid: string;
  security: WifiSecurity;
  secret: string | null;
  hidden: number;
  updated_at: number;
}

function read(): Row | undefined {
  ensureGuestWifiTable();
  return one<Row>("SELECT ssid, security, secret, hidden, updated_at FROM guest_wifi WHERE id = 1");
}

export function guestWifiConfigured(): boolean {
  return !!read();
}

export function guestWifi(): GuestWifiData {
  const r = read();
  if (!r) return { configured: false };
  let password: string | null = null;
  if (r.secret) {
    try {
      password = decrypt(r.secret);
    } catch {
      password = null; // the key changed: the admin has to enter it again
    }
  }
  const security = r.security;
  return {
    configured: true,
    ssid: r.ssid,
    security,
    password: security === "nopass" ? null : password,
    hidden: !!r.hidden,
    qr: matrix(wifiPayload(r.ssid, security, password, !!r.hidden)),
    updatedAt: r.updated_at,
  };
}

export function saveGuestWifi(input: z.infer<typeof guestWifiSchema>, by: string): GuestWifiData {
  const prev = read();
  let secret: string | null = null;
  if (input.security !== "nopass") {
    if (input.password !== undefined && input.password !== "") {
      checkPassword(input.security, input.password);
      secret = encrypt(input.password);
    } else if (prev?.secret && prev.security !== "nopass") {
      // Keeping the stored password: it still has to suit the (possibly changed) security type.
      try {
        checkPassword(input.security, decrypt(prev.secret));
      } catch (e) {
        if (e instanceof Error && "code" in e) throw e;
        throw badRequest("Enter the password again.", { field: "password" });
      }
      secret = prev.secret;
    } else {
      throw badRequest("Enter the network's password.", { field: "password" });
    }
  }
  run(
    `INSERT INTO guest_wifi (id, ssid, security, secret, hidden, updated_at, updated_by) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ssid = excluded.ssid, security = excluded.security, secret = excluded.secret,
       hidden = excluded.hidden, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    input.ssid,
    input.security,
    secret,
    input.hidden ? 1 : 0,
    now(),
    by,
  );
  return guestWifi();
}

export function removeGuestWifi() {
  ensureGuestWifiTable();
  run("DELETE FROM guest_wifi WHERE id = 1");
}
