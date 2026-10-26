/** Route params arrive decoded by Next; decode once more only when a client double-encoded them. */
export function param(v: string | string[] | undefined): string {
  const s = String(Array.isArray(v) ? v[0] : (v ?? ""));
  try {
    return /%[0-9a-f]{2}/i.test(s) ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}
