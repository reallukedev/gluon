import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, readHistory, remember } from "./history";
import { looksSecret } from "./redact";

describe("secrets stay out of history", () => {
  it.each([
    "mysql -u root -pHunter2 -e 'show databases'",
    "curl -u admin:hunter2 https://example.com",
    "curl -H 'Authorization: Bearer abc.def' https://api",
    "export GITHUB_TOKEN=ghp_123",
    "DB_PASSWORD=x docker compose up -d",
    "prosodyctl register luke chat.leech.party --password=hunter2",
    "restic backup --password hunter2 /srv",
    "git clone https://luke:hunter2@git.example.com/repo.git",
    "sshpass -p hunter2 ssh pi@10.0.0.2",
    "docker login -u luke -p hunter2",
    "htpasswd -b /etc/htpasswd luke hunter2",
    "app --client-secret=abc",
    "tool --api-key abc123",
  ])("skips %s", (cmd) => {
    expect(looksSecret(cmd)).toBe(true);
    expect(remember([], cmd)).toEqual([]);
  });

  it.each(["git log --author luke", "mysql -u root -p", "grep -r token src", "docker login --password-stdin -u luke", "ls -la /etc/prosody", "passwd luke"])("keeps %s", (cmd) => {
    expect(looksSecret(cmd)).toBe(false);
  });

  it("skips commands typed with a leading space, like bash's ignorespace", () => {
    expect(remember(["ls"], " cat /root/.env")).toEqual(["ls"]);
  });
});

describe("remember", () => {
  it("moves a repeated command to the front without duplicating it", () => {
    expect(remember(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("stays under the limit", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `echo ${i}`);
    const next = remember(full, "uptime");
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe("uptime");
  });
});

describe("readHistory", () => {
  it("survives whatever is in storage, and drops secrets saved before a rule existed", () => {
    expect(readHistory(null)).toEqual([]);
    expect(readHistory({ a: 1 })).toEqual([]);
    expect(readHistory(["ls", 3, "ls", "mysql -pX", ""])).toEqual(["ls"]);
  });
});
