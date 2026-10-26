import type { NextRequest } from "next/server";
import { PREVIEW_HEADERS, servePreview } from "@/server/sites/preview";

/**
 * A draft's pages, scripts and images for the preview frame. Not behind route(): the sandboxed
 * frame has no origin and no cookies, so the signed token in the path is the only credential.
 */
async function handle(req: NextRequest, { params }: { params: Promise<{ token: string; path?: string[] }> }) {
  const { token, path = [] } = await params;
  try {
    return servePreview(token, path, req.method === "HEAD");
  } catch {
    return new Response("Something went wrong showing this preview.", { status: 500, headers: { ...PREVIEW_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  }
}

export const GET = handle;
export const HEAD = handle;
