import "server-only";
import YAML from "yaml";
import { interpolate, splitColons } from "./vars";
import { resolveFrom } from "./paths";

/**
 * Every path on the server a compose file points at: bind mounts, env files, build contexts and
 * config or secret files, resolved against its project folder. Uninstall treats these as in use by
 * that app, so removing one app never deletes a file another app's compose file still needs.
 */
export function composeReferences(text: string, workingDir: string | null, vars: Record<string, string> = {}): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = (YAML.parse(text, { merge: true, maxAliasCount: -1 }) ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string" || !raw) return;
    const r = interpolate(raw, vars);
    if (r.missing.length || /^[a-z]+:\/\//.test(r.value) || r.value.startsWith("git@")) return;
    if (!r.value.startsWith("/") && !r.value.startsWith(".")) return; // a named volume
    const abs = resolveFrom(r.value, workingDir);
    if (abs) out.add(abs);
  };
  const services = (doc.services ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const svc of Object.values(services)) {
    if (!svc) continue;
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      if (typeof v === "string") {
        const bits = splitColons(v);
        if (bits.length > 1) add(bits[0]);
      } else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.type === "bind" || (typeof o.source === "string" && /^[./]/.test(o.source))) add(o.source);
      }
    }
    const envFiles = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
    for (const f of envFiles) add(typeof f === "object" && f ? (f as { path?: unknown }).path : f);
    if (svc.build !== undefined) add(typeof svc.build === "object" && svc.build ? ((svc.build as { context?: unknown }).context ?? ".") : svc.build);
  }
  for (const section of ["configs", "secrets"]) {
    const s = doc[section];
    if (s && typeof s === "object") for (const def of Object.values(s as Record<string, { file?: unknown } | null>)) add(def?.file);
  }
  return [...out].sort();
}
