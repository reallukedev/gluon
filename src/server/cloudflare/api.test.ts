import { describe, expect, it } from "vitest";
import { Cloudflare, CloudflareError } from "./api";

type Call = { url: string; init: RequestInit };

function fake(answers: ((c: Call) => { status?: number; body: unknown })[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!(c);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (result: unknown, info?: { page: number; total_pages: number }) => ({ body: { success: true, result, result_info: info } });

describe("Cloudflare client", () => {
  it("follows every page of a zone's records and sends the token as a bearer", async () => {
    const { f, calls } = fake([
      () => ok([{ id: "1", name: "a.example.com", type: "A", content: "203.0.113.7", proxied: false, comment: null }], { page: 1, total_pages: 2 }),
      () => ok([{ id: "2", name: "example.com", type: "CNAME", content: "t.cfargotunnel.com", proxied: true, comment: "Managed by Gluon" }], { page: 2, total_pages: 2 }),
    ]);
    const recs = await new Cloudflare("tok", f).records("z1");
    expect(recs.map((r) => r.id)).toEqual(["1", "2"]);
    expect(calls[1]!.url).toContain("/zones/z1/dns_records?per_page=500&page=2");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("turns Cloudflare's error codes into something a person can act on", async () => {
    const { f } = fake([
      () => ({ status: 401, body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }], result: null } }),
      () => ({ status: 403, body: { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }], result: null } }),
    ]);
    const cf = new Cloudflare("tok", f);
    const bad = await cf.zones().catch((e) => e);
    expect(bad).toBeInstanceOf(CloudflareError);
    expect(bad.message).toMatch(/didn't accept the token/);
    // A bad token is the person's to fix, not a server fault.
    expect(bad.status).toBe(400);
    expect((await cf.zones().catch((e) => e)).message).toMatch(/missing a permission/);
  });

  it("reports missing DNS edit rights as false rather than failing the whole check", async () => {
    const { f } = fake([() => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null } })]);
    await expect(new Cloudflare("tok", f).canEditDns("z1", "example.com")).resolves.toBe(false);
  });

  it("asks for a tunnel's token separately when the create answer doesn't carry it", async () => {
    const { f, calls } = fake([() => ok({ id: "t1", name: "gluon-home" }), () => ok("secret-token")]);
    await expect(new Cloudflare("tok", f).createTunnel("acc", "gluon-home")).resolves.toEqual({ id: "t1", name: "gluon-home", token: "secret-token" });
    expect(calls[1]!.url).toMatch(/\/accounts\/acc\/cfd_tunnel\/t1\/token$/);
  });
});
