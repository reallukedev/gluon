import { describe, expect, it } from "vitest";
import { chatServerOf, serviceKind } from "@/lib/service-kind";
import { installBody, toInstall } from "./install-schema";
import { chatRecipe, installSettings, QUARK_IMAGE, quarkRecipe } from "./recipe";
import { QUARK_ALT_PORTS, QUARK_PORTS } from "@/lib/chat-ports";
import { parseCompose, readServices } from "@/lib/builder/compose";

const install = { server: "quark" as const, domain: "chat.example.com", username: "sam", settings: installSettings("chat.example.com") };

describe("Quark's recipe", () => {
  const { compose, details } = quarkRecipe(install);

  it("runs the pinned image with the domain and the first admin from the environment", () => {
    expect(compose).toContain(`image: ${QUARK_IMAGE}`);
    expect(QUARK_IMAGE).toBe("ghcr.io/reallukedev/quark:0.1");
    expect(compose).toContain('QUARK_DOMAIN: "chat.example.com"');
    expect(compose).toContain('QUARK_ADMINS: "sam@chat.example.com"');
  });

  it("publishes sign-in, direct TLS, federation, the web side and the built-in call relay", () => {
    const ports = [...compose.matchAll(/^\s+- "(\d[^"]*)"$/gm)].map((m) => m[1]);
    expect(ports).toEqual(["5222:5222", "5223:5223", "5269:5269", "5280:5280", "3478:3478/udp", "3478:3478/tcp", "49160-49200:49160-49200/udp"]);
  });

  it("keeps the config and the data in the app's folder, left for Compose to fill in", () => {
    expect(compose).toContain("- ${APP_DATA_DIR}/data/config:/etc/quark\n");
    expect(compose).toContain("- ${APP_DATA_DIR}/data/lib:/var/lib/quark\n");
  });

  it("is named Quark and needs no second app for calls", () => {
    expect(details.name).toBe("Quark");
    expect(compose).not.toMatch(/coturn/);
  });

  it("is what the install picks unless the person asks for Prosody", () => {
    expect(chatRecipe(install).details.name).toBe("Quark");
    expect(chatRecipe({ ...install, server: "prosody" }).details.name).toBe("Prosody");
    const body = installBody.parse({ domain: "chat.example.com", username: "sam" });
    expect(toInstall(body).server).toBe("quark");
    expect(toInstall(installBody.parse({ domain: "chat.example.com", username: "sam", server: "prosody" })).server).toBe("prosody");
  });
});

describe("telling chat servers apart by image", () => {
  it("finds Quark from the published image or a local build", () => {
    for (const img of ["ghcr.io/reallukedev/quark:0.1", "quark", "quark:latest", "QUARK:dev"]) expect(chatServerOf(img)).toBe("quark");
    for (const img of ["quarkus/app:1", "ghcr.io/x/quarkly:1", "redis:7"]) expect(chatServerOf(img)).toBeNull();
    expect(chatServerOf("prosodyim/prosody:13.0")).toBe("prosody");
  });

  it("gives Quark and Prosody apps the Chat server tab", () => {
    expect(serviceKind(["ghcr.io/reallukedev/quark:0.1"])).toBe("quark");
    expect(serviceKind(["prosodyim/prosody:13.0"])).toBe("prosody");
    expect(serviceKind(["mumblevoip/mumble-server:latest"])).toBe("mumble");
  });
});

describe("Quark's recipe on the alternate ports", () => {
  const alt = QUARK_ALT_PORTS[0]!;
  const { compose } = quarkRecipe({ ...install, ports: alt });
  const ports = [...compose.matchAll(/^\s+- "(\d[^"]*)"$/gm)].map((m) => m[1]);

  it("moves sign-in, TLS, federation and the web side on the host only", () => {
    expect(ports.slice(0, 4)).toEqual(["5322:5222", "5323:5223", "5369:5269", "5380:5280"]);
  });

  it("keeps the relay on the same ports inside and out, and tells Quark which", () => {
    expect(ports.slice(4)).toEqual(["3479:3479/udp", "3479:3479/tcp", "49210-49250:49210-49250/udp"]);
    expect(compose).toContain('QUARK_TURN_PORT: "3479"');
    expect(compose).toContain('QUARK_TURN_RELAY_MIN: "49210"');
    expect(compose).toContain('QUARK_TURN_RELAY_MAX: "49250"');
  });

  it("is still valid compose", () => {
    const parsed = parseCompose(compose);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(readServices(parsed.doc)[0]!.ports.map((p) => p.raw ?? `${p.host}:${p.container}`)).toContain("5322:5222");
  });

  it("leaves the standard recipe without relay settings", () => {
    const std = quarkRecipe(install).compose;
    expect(std).not.toContain("QUARK_TURN_PORT");
    expect(quarkRecipe({ ...install, ports: QUARK_PORTS }).compose).toBe(std);
  });

  it("gives the relay the public address when Gluon knows it, and only a real IPv4", () => {
    expect(quarkRecipe({ ...install, externalIp: "203.0.113.7" }).compose).toContain('QUARK_TURN_EXTERNAL_IP: "203.0.113.7"');
    expect(quarkRecipe({ ...install, externalIp: null }).compose).not.toContain("QUARK_TURN_EXTERNAL_IP");
    expect(quarkRecipe({ ...install, externalIp: '1.2.3.4"\n  evil: x' }).compose).not.toContain("QUARK_TURN_EXTERNAL_IP");
  });

  it("leaves Prosody's recipe as it was", () => {
    const p = chatRecipe({ ...install, server: "prosody", ports: alt }).compose;
    expect([...p.matchAll(/^\s+- "(\d[^"]*)"$/gm)].map((m) => m[1])).toEqual(["5222:5222", "5269:5269", "5280:5280"]);
  });
});
