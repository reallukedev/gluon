import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  // Dev only: lets the dev server be tested from a second local origin (e.g. a member session).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["better-sqlite3", "dockerode", "@node-rs/argon2", "ssh2", "cpu-features", "nodemailer", "archiver", "unzipper", "sharp", "ice"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
    optimizePackageImports: ["iconoir-react"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()" },
          // A private tool: keep every page and file out of search engines.
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      // Everything except file previews may never be framed; previews (PDF) are framed by Gluon itself.
      { source: "/((?!api/files/raw).*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      { source: "/api/files/raw", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      // API answers are data, never documents: no scripts, no framing, not readable by other sites.
      // (/api/files/raw sets its own policy per file type, and must stay framable for PDF previews.)
      {
        source: "/api/((?!files/raw).*)",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
