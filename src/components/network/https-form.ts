import type { CertUploads, HttpsModeT, HttpsSettingsT, OwnCertInfo, OwnCertState, SubdomainRouteT } from "@/lib/network-types";
import { api, ApiError } from "@/lib/client/api";

export type CertSource = "paste" | "files";

export interface HttpsForm {
  mode: HttpsModeT;
  source: CertSource;
  cert: string;
  key: string;
  certFile: string;
  keyFile: string;
  replacing: boolean;
  checked: { sig: string; info: OwnCertInfo } | null;
}

export const certbotFiles = (host: string) => ({ cert: `/etc/letsencrypt/live/${host || "example.com"}/fullchain.pem`, key: `/etc/letsencrypt/live/${host || "example.com"}/privkey.pem` });

export function httpsFormFrom(r: SubdomainRouteT | undefined): HttpsForm {
  const h = r?.https;
  return {
    mode: h?.mode ?? "auto",
    source: h?.files ? "files" : "paste",
    cert: "",
    key: "",
    certFile: h?.files?.cert ?? "",
    keyFile: h?.files?.key ?? "",
    replacing: false,
    checked: null,
  };
}

const sig = (f: HttpsForm, host: string) => (f.source === "files" ? `files|${host}|${f.certFile.trim()}|${f.keyFile.trim()}` : `paste|${host}|${f.cert}|${f.key}`);

export function hasNewCert(f: HttpsForm, prev: SubdomainRouteT | undefined, stored: OwnCertState | undefined, host: string): boolean {
  if (f.mode !== "own") return false;
  const sameHost = !!prev && prev.host === host && prev.https?.mode === "own";
  if (f.source === "files") {
    const same = sameHost && prev?.https?.files?.cert === f.certFile.trim() && prev?.https?.files?.key === f.keyFile.trim();
    return !same || !stored?.stored;
  }
  return f.replacing || !sameHost || !stored?.stored || !!prev?.https?.files;
}

export function httpsSetting(f: HttpsForm): HttpsSettingsT | undefined {
  if (f.mode === "auto") return undefined;
  if (f.mode !== "own") return { mode: f.mode };
  return f.source === "files" ? { mode: "own", files: { cert: f.certFile.trim(), key: f.keyFile.trim() } } : { mode: "own" };
}

export function certUploads(f: HttpsForm, host: string, isNew: boolean): CertUploads {
  return f.mode === "own" && f.source === "paste" && isNew ? { [host]: { cert: f.cert, key: f.key } } : {};
}

const FIELD: Record<string, keyof HttpsForm> = { cert: "cert", key: "key", cert_file: "certFile", key_file: "keyFile" };

/** Nothing is stored. */
export async function verifyHttps(f: HttpsForm, host: string): Promise<{ form: HttpsForm } | { errors: Record<string, string> }> {
  const s = sig(f, host);
  if (f.checked?.sig === s) return { form: f };
  if (f.source === "paste") {
    if (!f.cert.trim()) return { errors: { cert: "Paste the certificate and its chain, or open its file." } };
    if (!f.key.trim()) return { errors: { key: "Paste the private key, or open its file." } };
  } else {
    if (!f.certFile.trim().startsWith("/")) return { errors: { certFile: "Enter the full path to the certificate, starting with /." } };
    if (!f.keyFile.trim().startsWith("/")) return { errors: { keyFile: "Enter the full path to the key, starting with /." } };
  }
  try {
    const body = f.source === "files" ? { host, files: { cert: f.certFile.trim(), key: f.keyFile.trim() } } : { host, cert: f.cert, key: f.key };
    const r = await api.post<{ info: OwnCertInfo }>("/api/network/certs", body);
    return { form: { ...f, checked: { sig: s, info: r.info } } };
  } catch (e) {
    if (e instanceof ApiError && e.field && FIELD[e.field]) return { errors: { [FIELD[e.field]!]: e.message } };
    return { errors: { https: e instanceof Error ? e.message : "Gluon couldn't check the certificate." } };
  }
}

export function httpsFieldOf(field: string | undefined): string | null {
  if (!field) return null;
  if (field === "https") return "https";
  return (FIELD[field] as string | undefined) ?? null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function httpsSummary(f: HttpsForm, stored: OwnCertState | undefined): string {
  switch (f.mode) {
    case "auto":
      return "Gluon gets a certificate and renews it";
    case "http":
      return "Plain HTTP; something in front handles HTTPS";
    case "none":
      return "The chat server handles its own; no web page here";
    case "own": {
      const info = f.checked?.info ?? (f.replacing ? null : stored?.stored);
      const from = f.source === "files" ? ", copied from its files" : "";
      return info ? `Your own certificate, ends ${day(info.validTo)}${from}` : `Your own certificate${from}`;
    }
  }
}
