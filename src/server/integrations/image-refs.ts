import "server-only";

/**
 * The image proxy only serves images that a widget has handed out (poster ids, cover ids, asset ids), so it can't
 * be used to walk an app's whole library (e.g. every private photo in Immich) by guessing ids.
 * Refs live in memory for 12 hours; the widget data that contains the URLs refreshes far more often.
 */

const TTL = 12 * 60 * 60_000;
const MAX_PER_INTEGRATION = 5000;

type G = typeof globalThis & { __gluonImageRefs?: Map<string, Map<string, number>> };
const g = globalThis as G;
const refs = (g.__gluonImageRefs ??= new Map());

export function allowImage(integrationId: string, ref: string) {
  let m = refs.get(integrationId);
  if (!m) refs.set(integrationId, (m = new Map()));
  m.delete(ref);
  m.set(ref, Date.now() + TTL);
  if (m.size > MAX_PER_INTEGRATION) {
    // Map keeps insertion order: drop the oldest.
    const drop = m.size - MAX_PER_INTEGRATION;
    let i = 0;
    for (const k of m.keys()) {
      if (i++ >= drop) break;
      m.delete(k);
    }
  }
}

export function isImageAllowed(integrationId: string, ref: string): boolean {
  const exp = refs.get(integrationId)?.get(ref);
  return !!exp && exp > Date.now();
}

export function forgetImages(integrationId: string) {
  refs.delete(integrationId);
}

export function pruneImageRefs() {
  const now = Date.now();
  for (const [id, m] of refs) {
    for (const [k, exp] of m) if (exp <= now) m.delete(k);
    if (!m.size) refs.delete(id);
  }
}

/** Same-origin proxy URL for an image, registering it in the allowlist. null when there's no saved integration. */
export function imageUrl(integrationId: string | null, ref: string, params: Record<string, string | number>): string | null {
  if (!integrationId) return null;
  allowImage(integrationId, ref);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `/api/integrations/${encodeURIComponent(integrationId)}/image?${q.toString()}`;
}

/** Round a requested width up to a fixed step so browsers and upstream caches reuse variants. */
export const WIDTHS = [96, 160, 240, 320, 480, 720, 1080, 1440] as const;
export function bucketWidth(w: number): number {
  return WIDTHS.find((b) => b >= w) ?? WIDTHS[WIDTHS.length - 1]!;
}
