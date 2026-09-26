import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for pages: a per-request nonce Content-Security-Policy (Next applies the nonce to
 * its own scripts), HSTS when the browser came in over HTTPS, and no indexing.
 *
 * Pages only. API responses get their static headers from next.config.ts; running this for /api would
 * also make Next buffer request bodies (uploads).
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === "development";
  const https = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";

  const csp = [
    "default-src 'self'",
    // strict-dynamic: scripts Next loads from its nonce'd bootstrap are trusted; nothing else runs.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Components set style attributes (bar widths, positions); attributes can't carry a nonce.
    "style-src 'self' 'unsafe-inline'",
    // App icons and store screenshots come from app stores' CDNs and from apps on the LAN.
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // PDF previews (/api/files/raw) and pages from apps shown inside Gluon.
    "frame-src 'self' https: http:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (https) response.headers.set("Strict-Transport-Security", "max-age=31536000");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|icon\\.svg|manifest\\.webmanifest|favicon\\.ico|robots\\.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
