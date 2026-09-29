import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Hubot_Sans, Martian_Mono, Mona_Sans } from "next/font/google";
import { decodeUiCookie, htmlAttrs, UI_COOKIE } from "@/lib/prefs";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
import "./globals.css";

// Mona Sans reads; Hubot Sans (its engineered sibling) engraves headings, figures and labels; Martian Mono
// marks anything a person might type. All three are variable on the width axis, which the type scale leans on.
const sans = Mona_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mona", display: "swap" });
const display = Hubot_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-hubot", display: "swap" });
const mono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-martian", display: "swap" });

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
  const bits = decodeUiCookie((await cookies()).get(UI_COOKIE)?.value);
  // Base UI's few inline scripts (the tab indicator placing itself before hydration) need the page's nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" {...htmlAttrs(bits)} className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <CSPProvider nonce={nonce}>
          <TooltipProvider>
            <ToastProvider>{children}</ToastProvider>
          </TooltipProvider>
        </CSPProvider>
      </body>
    </html>
  );
}
