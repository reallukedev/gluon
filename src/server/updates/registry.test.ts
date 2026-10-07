import { describe, expect, test } from "vitest";
import { compareDigest, parseChallenge, planImageCheck } from "./registry";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

describe("which app images can be checked for updates", () => {
  test.each([
    ["pinned by digest", `jellyfin/jellyfin:10.10@${A}`, [`jellyfin/jellyfin@${A}`], {}, "pinned"],
    ["built by Gluon", "gluon.local/notes:3", [], {}, "built"],
    ["built by Compose", "notes-web", [], { "com.docker.compose.image.builder": "classic" }, "built"],
    ["never pulled (no repository digest)", "myimage:dev", [], {}, "built"],
    ["pulled from another registry than the one it's tagged for", "ghcr.io/immich-app/immich-server:release", [`docker.io/altendky/immich@${A}`], {}, "unknown_local"],
    ["an image id, not a name", `sha256:${"c".repeat(64)}`, [], {}, "not_a_ref"],
  ])("skips an image %s", (_n, ref, digests, labels, reason) => {
    expect(planImageCheck(ref, digests, labels)).toEqual({ check: false, reason });
  });

  test("Docker Hub short names, library images and a missing tag resolve to what the registry calls them", () => {
    expect(planImageCheck("nginx", [`nginx@${A}`])).toEqual({ check: true, registry: "docker.io", repository: "library/nginx", tag: "latest", local: [A] });
    expect(planImageCheck("jellyfin/jellyfin:10.10", [`docker.io/jellyfin/jellyfin@${A}`])).toMatchObject({ check: true, repository: "jellyfin/jellyfin", tag: "10.10", local: [A] });
    expect(planImageCheck("ghcr.io/immich-app/immich-server:release", [`ghcr.io/immich-app/immich-server@${A}`, `other/x@${B}`])).toMatchObject({ registry: "ghcr.io", local: [A] });
  });
});

describe("reading the registry's answer", () => {
  test("a tag that moved is newer; the same digest (from any of the image's names) is not", () => {
    expect(compareDigest([A], B)).toBe("newer");
    expect(compareDigest([B, A], A)).toBe("same");
  });

  test("no digest, or something that isn't one, is unknown rather than an update", () => {
    expect(compareDigest([A], null)).toBe("unknown");
    expect(compareDigest([A], "sha512:zzz")).toBe("unknown");
  });

  test("anonymous token challenges from Docker Hub and GHCR", () => {
    expect(parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io"')).toEqual({ realm: "https://auth.docker.io/token", service: "registry.docker.io" });
    expect(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"')).toEqual({ realm: "https://ghcr.io/token", service: "ghcr.io" });
    expect(parseChallenge('Basic realm="Registry"')).toBeNull();
    expect(parseChallenge('Bearer realm="http://plain.example/token"')).toBeNull();
  });
});
