import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPost } from "./api";

function respondWith(chunks: string[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe("streamPost", () => {
  it("delivers the last event even without a trailing newline", async () => {
    respondWith(['{"type":"step"}\n{"type":"li', 'ne"}\n{"type":"done","ok":true}']);
    const seen: unknown[] = [];
    await streamPost("/api/example", {}, (e) => seen.push(e));
    expect(seen).toEqual([{ type: "step" }, { type: "line" }, { type: "done", ok: true }]);
  });

  it("skips a line that isn't JSON instead of throwing away the stream", async () => {
    respondWith(['{"type":"step"}\n', "<html>proxy error</html>\n", '{"type":"done","ok":false}\n']);
    const seen: unknown[] = [];
    await streamPost("/api/example", {}, (e) => seen.push(e));
    expect(seen).toEqual([{ type: "step" }, { type: "done", ok: false }]);
  });
});
