import "server-only";
import { db, now, one, run, all } from "../db";
import { decryptJson, encryptJson } from "../crypto";

/**
 * What Gluon remembers per voice server: Ice's secrets (encrypted at rest with the server key)
 * and which public address's certificate it keeps Mumble's current with.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS voice_servers (
  app_id TEXT PRIMARY KEY,
  secrets_enc TEXT NOT NULL,
  ice_port INTEGER NOT NULL,
  cert_domain TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`;

type G = typeof globalThis & { __gluonVoiceSchema?: boolean };
const g = globalThis as G;
function ensure() {
  if (g.__gluonVoiceSchema) return;
  db().exec(SCHEMA);
  g.__gluonVoiceSchema = true;
}

export interface IceSecrets {
  write: string;
  read: string;
}

export interface VoiceRecord {
  appId: string;
  icePort: number;
  secrets: IceSecrets | null;
  certDomain: string | null;
}

interface Row {
  app_id: string;
  secrets_enc: string;
  ice_port: number;
  cert_domain: string | null;
}

function parse(r: Row): VoiceRecord {
  let secrets: IceSecrets | null = null;
  try {
    secrets = decryptJson<IceSecrets>(r.secrets_enc);
  } catch {
    secrets = null; // the server key changed: Gluon has to set Ice up again
  }
  return { appId: r.app_id, icePort: r.ice_port, secrets, certDomain: r.cert_domain };
}

export function getVoice(appId: string): VoiceRecord | null {
  ensure();
  const r = one<Row>("SELECT * FROM voice_servers WHERE app_id = ?", appId);
  return r ? parse(r) : null;
}

export function listVoice(): VoiceRecord[] {
  ensure();
  return all<Row>("SELECT * FROM voice_servers").map(parse);
}

export function saveVoice(appId: string, v: { icePort: number; secrets: IceSecrets }) {
  ensure();
  run(
    `INSERT INTO voice_servers (app_id, secrets_enc, ice_port, cert_domain, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET secrets_enc = excluded.secrets_enc, ice_port = excluded.ice_port, updated_at = excluded.updated_at`,
    appId,
    encryptJson(v.secrets),
    v.icePort,
    now(),
    now(),
  );
}

export function setCertDomain(appId: string, domain: string | null) {
  ensure();
  run("UPDATE voice_servers SET cert_domain = ?, updated_at = ? WHERE app_id = ?", domain, now(), appId);
}
