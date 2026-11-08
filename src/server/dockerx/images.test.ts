import { describe, expect, it, vi } from "vitest";

/** Whether an unused image can be downloaded again: a registry that can't be reached isn't a "no". */

let answer: () => unknown = () => ({});
vi.mock("../docker/client", () => ({ docker: () => ({}) }));
vi.mock("../docker/apps", () => ({ invalidateApps: () => undefined }));
vi.mock("../events", () => ({ publish: () => undefined }));
vi.mock("./core", () => ({
  dial: async () => answer(),
  dockerError: (e: unknown) => e,
  dockerMessage: (e: { message?: string }) => e.message ?? "",
  invalidateSnapshot: () => undefined,
  names: (l: string[]) => l.join(", "),
  snapshot: async () => ({}),
  usersText: () => "",
}));

const { remoteState, splitRef } = await import("./images");
const fail = (message: string) => () => {
  throw new Error(message);
};

describe("remoteState", () => {
  it("says unknown, not missing, when the registry can't be reached", async () => {
    answer = fail("Get \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io: no such host");
    expect((await remoteState("example/app:1", [], true)).status).toBe("unknown");
    answer = fail("Get \"https://registry.example.com/v2/\": net/http: TLS handshake timeout");
    expect((await remoteState("registry.example.com/app:1", [], true)).status).toBe("unknown");
  });

  it("says missing when the registry answers that it has no such image", async () => {
    answer = fail("manifest unknown");
    expect((await remoteState("example/gone:1", [], true)).status).toBe("missing");
    answer = fail("pull access denied for example/private, repository does not exist or may require 'docker login'");
    expect((await remoteState("example/private:1", [], true)).status).toBe("missing");
  });

  it("tells the same digest from a newer one", async () => {
    const d = "sha256:" + "a".repeat(64);
    answer = () => ({ Descriptor: { digest: d } });
    expect((await remoteState("example/app:2", [d], true)).status).toBe("same");
    expect((await remoteState("example/app:3", ["sha256:" + "b".repeat(64)], true)).status).toBe("newer");
  });

  it("splits a reference with a registry port", () => {
    expect(splitRef("registry.example.com:5000/team/app:1.2")).toEqual({ repo: "registry.example.com:5000/team/app", tag: "1.2", digest: null });
  });
});
