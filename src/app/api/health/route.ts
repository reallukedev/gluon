import { one } from "@/server/db";

/** Liveness for Docker's healthcheck and the "waiting for restart" screen. No auth, no details. */
export function GET() {
  try {
    one("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
