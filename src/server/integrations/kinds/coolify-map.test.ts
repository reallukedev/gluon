import { describe, expect, test } from "vitest";
import { deploymentList, mergeRecent, parseVersion, resourceLine, toDeployment, toResource } from "./coolify-map";

// A row of application_deployment_queues as Coolify 4.3 returns it from /api/v1/deployments (trimmed).
const row = {
  id: 41,
  application_id: "3",
  deployment_uuid: "kcg8w0o4scsw8k",
  pull_request_id: 0,
  force_rebuild: false,
  commit: "9f2c1d7e5b8a43c0d1e2f3a4b5c6d7e8f9a0b1c2",
  status: "in_progress",
  is_webhook: true,
  is_api: false,
  created_at: "2026-10-07T09:12:44.000000Z",
  updated_at: "2026-10-07T09:13:10.000000Z",
  logs: "[{\"output\":\"secret build log\"}]",
  application_name: "blog",
  server_name: "localhost",
  deployment_url: "/project/p1/environment/e1/application/a1/deployment/kcg8w0o4scsw8k",
  commit_message: "Fix the header\n\nLonger body that shouldn't show",
  finished_at: null,
};

describe("deployments", () => {
  test("a running deployment: short commit, first line of the message, no logs", () => {
    const d = toDeployment(row)!;
    expect(d).toEqual({
      id: "kcg8w0o4scsw8k",
      app: "blog",
      status: "in_progress",
      commit: "9f2c1d7",
      message: "Fix the header",
      startedAt: Date.parse("2026-10-07T09:12:44Z"),
      finishedAt: null,
      path: "/project/p1/environment/e1/application/a1/deployment/kcg8w0o4scsw8k",
      server: "localhost",
      trigger: "webhook",
    });
  });

  test.each([
    ["finished", "finished"],
    ["failed", "failed"],
    ["cancelled-by-user", "cancelled"],
    ["queued", "queued"],
  ])("status %s", (raw, want) => {
    expect(toDeployment({ ...row, status: raw })!.status).toBe(want);
  });

  test("a finished one falls back to updated_at; old space-separated times are UTC; foreign links are dropped", () => {
    const d = toDeployment({ ...row, status: "finished", created_at: "2026-10-07 09:12:44", deployment_url: "//evil.example/x", commit: "HEAD" })!;
    expect(d.startedAt).toBe(Date.parse("2026-10-07T09:12:44Z"));
    expect(d.finishedAt).toBe(Date.parse("2026-10-07T09:13:10Z"));
    expect(d.path).toBeNull();
    expect(d.commit).toBeNull();
  });

  test("both list shapes, newest first, each once", () => {
    const a = toDeployment({ ...row, deployment_uuid: "aaaaaa1", status: "finished", finished_at: "2026-10-07T08:00:00Z" })!;
    const b = toDeployment({ ...row, deployment_uuid: "bbbbbb2", status: "failed", finished_at: "2026-10-07T10:00:00Z" })!;
    expect(deploymentList({ count: 1, deployments: [row] })).toHaveLength(1);
    expect(deploymentList([row, row])).toHaveLength(2);
    expect(deploymentList({ message: "nope" })).toEqual([]);
    expect(mergeRecent([[a, b], [b]], 5).map((d) => d.id)).toEqual(["bbbbbb2", "aaaaaa1"]);
  });
});

describe("resources", () => {
  test.each([
    ["running:healthy", "running"],
    ["running:unknown", "running"],
    ["running:unhealthy", "unhealthy"],
    ["degraded:unhealthy", "unhealthy"],
    ["exited:unhealthy", "stopped"],
    ["restarting", "starting"],
    ["", "stopped"],
  ])("%s", (status, line) => {
    expect(resourceLine(status)).toBe(line);
  });

  test("databases are recognised by their standalone type", () => {
    expect(toResource({ uuid: "dbuuid1", name: "postgres", type: "standalone-postgresql", status: "running:healthy" })).toMatchObject({ type: "database", line: "running" });
    expect(toResource({ uuid: "x", type: "application" })).toBeNull();
  });
});

test.each([
  ["4.3.23", "4.3.23"],
  ['"v4.0.0-beta.420"', "4.0.0-beta.420"],
  ["<html>", null],
])("version %s", (text, want) => {
  expect(parseVersion(text)).toBe(want);
});
