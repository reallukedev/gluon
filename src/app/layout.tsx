import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Atkinson_Hyperlegible_Mono, Radio_Canada, Special_Gothic } from "next/font/google";
import { htmlAttrs, UI_COOKIE } from "@/lib/prefs";
import { decodeUiCookie } from "@/lib/prefs-schema";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { HydrationMark } from "@/lib/client/motion";
import { ServerClock } from "@/lib/client/seed";
import "./globals.css";

// The sans faces are variable on the width axis, which the type scale relies on. The mono keeps 0/O and 1/l/I apart.
const sans = Radio_Canada({ subsets: ["latin"], axes: ["wdth"], variable: "--font-reading", display: "swap" });
const display = Special_Gothic({ subsets: ["latin"], axes: ["wdth"], variable: "--font-placard", display: "swap" });
const mono = Atkinson_Hyperlegible_Mono({ subsets: ["latin"], variable: "--font-typed", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Gluon", template: "%s · Gluon" },
  description: "Your home server, at a glance.",
  applicationName: "Gluon",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Gluon", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ef" },
    { media: "(prefers-color-scheme: dark)", color: "#111214" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const bits = decodeUiCookie(jar.get(UI_COOKIE)?.value);
  // Base UI's few inline scripts (the tab indicator placing itself before hydration) need the page's nonce.
  const nonce = h.get("x-nonce") ?? undefined;
  return (
    <html lang="en" {...htmlAttrs(bits)} className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <HydrationMark />
        <ServerClock now={Date.now()} />
        <CSPProvider nonce={nonce}>
          <TooltipProvider>
            <ToastProvider>{children}</ToastProvider>
          </TooltipProvider>
        </CSPProvider>
      </body>
    </html>
  );
}
