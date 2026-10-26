import { describe, expect, it } from "vitest";
import { composeReferences } from "./refs";

describe("composeReferences", () => {
  it("finds every path a compose file points at, relative ones resolved, named volumes left out", () => {
    const text = `x-common: &common
  env_file: .env
services:
  web:
    <<: *common
    build: ./app
    volumes:
      - ./data:/data
      - \${MEDIA:-/mnt/media}:/media:ro
      - cache:/cache
      - type: bind
        source: ../shared/certs
        target: /certs
  worker:
    build:
      context: https://github.com/x/y.git
    env_file:
      - path: ./worker.env
        required: false
configs:
  site:
    file: ./site.conf
volumes:
  cache: {}
`;
    expect(composeReferences(text, "/var/lib/casaos/apps/web")).toEqual([
      "/mnt/media",
      "/var/lib/casaos/apps/shared/certs",
      "/var/lib/casaos/apps/web/.env",
      "/var/lib/casaos/apps/web/app",
      "/var/lib/casaos/apps/web/data",
      "/var/lib/casaos/apps/web/site.conf",
      "/var/lib/casaos/apps/web/worker.env",
    ]);
  });

  it("skips what it can't resolve rather than guessing", () => {
    expect(composeReferences("services:\n  a:\n    volumes:\n      - ${UNSET}/x:/x\n", "/srv/a")).toEqual([]);
    expect(composeReferences("not: [valid", "/srv/a")).toEqual([]);
  });
});
