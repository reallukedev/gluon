import { expect, test } from "vitest";
import { xmppVerdict } from "./xmpp-verdict";
import type { TlsResult, XmppStatus } from "@/lib/network-types";

const tlsOk: TlsResult = { servername: "chat.example.test", status: "ok", issuer: "LE", subject: null, names: [], validFrom: null, validTo: null, daysLeft: 80, trusted: true, issueError: null, message: "Valid for 80 more days." };
const healthy: XmppStatus = {
  domain: "chat.example.test",
  srv: { client: { name: "c", records: [], status: "missing", message: "" }, server: { name: "s", records: [], status: "missing", message: "" } },
  c2s: { port: 5222, reachable: true, ms: 3, error: null, tls: tlsOk },
  s2s: { port: 5269, reachable: true, ms: 3, error: null, tls: tlsOk },
  web: null,
  openRegistration: false,
  certSync: { container: "prosody", checkedAt: 1, copiedAt: null, ok: true, message: "" },
  reach: null,
};
const without = (patch: Partial<XmppStatus>) => xmppVerdict({ ...healthy, ...patch });

test("a healthy server, including missing SRV records on standard ports, has nothing to say", () => {
  expect(xmppVerdict(healthy)).toBeNull();
});

test.each([
  ["sign-in breaks", { c2s: { ...healthy.c2s, error: "the chat server refused to start encryption" }, certSync: { ...healthy.certSync!, ok: false, message: "sync broke" } }, "fault", /can't sign in/],
  ["its certificate expired", { c2s: { ...healthy.c2s, tls: { ...tlsOk, status: "expired" as const, message: "Expired." } } }, "fault", /refuse to connect/],
  ["the sync fails while federation is also down", { certSync: { ...healthy.certSync!, ok: false, message: "sync broke" }, s2s: { ...healthy.s2s!, reachable: false, error: "no answer" } }, "attention", /sync broke/],
  ["other servers can't reach it", { s2s: { ...healthy.s2s!, reachable: false, error: "no answer" } }, "attention", /Other chat servers can't reach port 5269/],
  ["the web port is down", { web: { host: "h", port: 5280, reachable: false, ms: null, error: "nothing is listening there" } }, "attention", /web port \(5280\)/],
] as const)("ranks it when %s", (_, patch, state, summary) => {
  const v = without(patch as Partial<XmppStatus>);
  expect(v?.state).toBe(state);
  expect(v?.summary).toMatch(summary);
});
