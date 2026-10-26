import { describe, expect, it } from "vitest";
import { analyze, matchQuality, suggest, type Sources } from "./complete";
import type { SpecNode } from "./types";

const docker: SpecNode = {
  name: ["docker"],
  subcommands: [
    { name: ["ps"], description: "List containers", options: [{ name: ["-a", "--all"], description: "Show all containers" }] },
    {
      name: ["logs"],
      description: "Fetch the logs of a container",
      args: [{ name: "container" }],
      options: [
        { name: ["-f", "--follow"], description: "Follow log output" },
        { name: ["-n", "--tail"], description: "Number of lines", args: [{ name: "lines", suggestions: [{ name: "50" }, { name: "all" }] }] },
      ],
    },
    { name: ["exec"], args: [{ name: "container" }, { name: "command", variadic: true }] },
    { name: ["restart"], args: [{ name: "container", variadic: true }] },
    { name: ["cp"], args: [{ name: "src", template: ["filepaths"] }] },
  ],
  options: [{ name: ["--host", "-H"], description: "Daemon socket", persistent: true, args: [{ name: "host" }] }],
};

const none: Sources = { history: [], commands: null, spec: null, entries: null, containers: [], units: [] };

function run(line: string, src: Partial<Sources> = {}, cursor = line.length) {
  const s = { ...none, ...src };
  const a = analyze(line, cursor, s.spec);
  return { a, list: suggest(line, cursor, a, s) };
}

describe("matchQuality", () => {
  it("rejects unrelated words and loose matches on short input", () => {
    expect(matchQuality("restart", "zz")).toBe(0);
    expect(matchQuality("restart", "tr")).toBe(0);
  });

  it("ranks a prefix above a case-insensitive prefix above a substring", () => {
    const prefix = matchQuality("Dockerfile", "Dock");
    const folded = matchQuality("Dockerfile", "dock");
    const inside = matchQuality("Dockerfile", "kerf");
    expect(prefix).toBeGreaterThan(folded);
    expect(folded).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
  });
});

describe("analyze", () => {
  it("doesn't ask for files while the command name is being typed", () => {
    expect(run("dock").a).toMatchObject({ atCommand: true, dir: null, program: null });
  });

  it("asks for the folder of a path being typed", () => {
    expect(run("cat /etc/pros").a.dir).toBe("/etc/");
    expect(run("ls ").a.dir).toBe("");
    expect(run("./scr").a.dir).toBe("./");
  });

  it("asks for containers only where docker takes one", () => {
    expect(run("docker logs ", { spec: docker }).a.wantsContainers).toBe(true);
    expect(run("docker exec web ", { spec: docker }).a.wantsContainers).toBe(false);
    expect(run("docker restart a ", { spec: docker }).a.wantsContainers).toBe(true);
    expect(run("docker ps ", { spec: docker }).a.wantsContainers).toBe(false);
    expect(run("docker logs -", { spec: docker }).a.wantsContainers).toBe(false);
  });

  it("asks for units after systemctl verbs and journalctl -u", () => {
    expect(run("systemctl restart ").a.wantsUnits).toBe(true);
    expect(run("systemctl list-units ").a.wantsUnits).toBe(false);
    expect(run("journalctl -u ").a.wantsUnits).toBe(true);
    expect(run("sudo journalctl -f -u jel").a.wantsUnits).toBe(true);
  });
});

describe("suggest", () => {
  it("suggests nothing from programs until a letter is typed", () => {
    expect(run("", { commands: ["ls", "lsblk"] }).list).toEqual([]);
  });

  it("completes subcommands with their descriptions, replacing only the current word", () => {
    const { list } = run("docker lo", { spec: docker });
    expect(list[0]).toMatchObject({ kind: "subcommand", label: "logs", description: "Fetch the logs of a container", line: "docker logs ", caret: 12 });
  });

  it("doesn't offer an option that's already used, but keeps inherited ones", () => {
    const labels = run("docker ps -a -", { spec: docker }).list.map((s) => s.label);
    expect(labels).not.toContain("-a, --all");
    expect(labels).toContain("--host, -H");
  });

  it("suggests an option's values after the option", () => {
    const { list } = run("docker logs -n ", { spec: docker });
    expect(list.map((s) => s.label)).toEqual(["50", "all"]);
    expect(run("docker logs --tail=a", { spec: docker }).list[0]).toMatchObject({ line: "docker logs --tail=all " });
  });

  it("ranks history first and fills the whole line", () => {
    const { list } = run("docker lo", { spec: docker, history: ["docker logs -f prosody-prosody-1", "ls"] });
    expect(list[0]).toMatchObject({ kind: "history", line: "docker logs -f prosody-prosody-1" });
    expect(list.some((s) => s.label === "ls")).toBe(false);
  });

  it("shows recent history on an empty line", () => {
    const history = Array.from({ length: 12 }, (_, i) => `echo ${i}`);
    const { list } = run("", { history });
    expect(list).toHaveLength(8);
    expect(list[0]!.line).toBe("echo 0");
  });

  it("completes containers and units by name", () => {
    expect(run("docker logs pro", { spec: docker, containers: ["prosody-prosody-1", "mumble-server"] }).list.map((s) => s.label)).toEqual(["prosody-prosody-1"]);
    const unit = run("systemctl restart jelly", { units: ["jellyfin.service", "docker.socket"] }).list[0];
    expect(unit).toMatchObject({ kind: "unit", label: "jellyfin.service", line: "systemctl restart jellyfin " });
  });

  it("completes files and folders: folders keep the cursor inside, hidden ones need a dot", () => {
    const entries = [
      { name: "prosody", dir: true },
      { name: "profile", dir: false },
      { name: ".pros-secret", dir: false },
    ];
    const { list } = run("cat /etc/pro", { entries });
    expect(list.map((s) => s.line)).toEqual(["cat /etc/prosody/", "cat /etc/profile "]);
    expect(run("cat /etc/.pr", { entries }).list.map((s) => s.label)).toEqual([".pros-secret"]);
  });

  it("offers only folders to cd, with spaces escaped", () => {
    const entries = [
      { name: "My Stuff", dir: true },
      { name: "Makefile", dir: false },
    ];
    expect(run("cd M", { entries }).list.map((s) => s.line)).toEqual(["cd My\\ Stuff/"]);
  });

  it("finishes inside an open quote", () => {
    const entries = [{ name: "a b.txt", dir: false }];
    expect(run(`cat "a`, { entries }).list[0]!.line).toBe(`cat "a b.txt" `);
  });

  it("completes program names from the PATH and builtins", () => {
    const { list } = run("syst", { commands: ["systemctl", "systemd-analyze", "sync"] });
    expect(list.map((s) => s.label)).toEqual(["systemctl", "systemd-analyze"]);
  });
});
