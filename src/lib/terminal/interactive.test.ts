import { describe, expect, it } from "vitest";
import { interactiveProgram } from "./interactive";

const prog = (line: string) => interactiveProgram(line)?.program ?? null;

describe("interactiveProgram", () => {
  it.each([
    "top -b -n 1",
    "ls -la",
    "docker exec web ls",
    "docker compose exec -T db pg_dump",
    "ssh pi@10.0.0.2 uptime",
    "bash -c 'echo hi'",
    "sh script.sh",
    "python3 manage.py migrate",
    "mysql -u root -e 'show databases'",
    "psql -c 'select 1'",
    "sqlite3 db.sqlite '.tables'",
    "redis-cli ping",
    "journalctl -u docker --no-pager",
    "emacs --batch -l x.el",
    "echo vim",
    "su -c whoami",
  ])("lets %s run as a block", (line) => {
    expect(prog(line)).toBeNull();
  });

  it.each([
    ["vim /etc/hosts", "vim"],
    ["sudo nano /etc/fstab", "nano"],
    ["htop", "htop"],
    ["top", "top"],
    ["journalctl -u docker | less", "less"],
    ["man tar", "man"],
    ["ssh pi@10.0.0.2", "ssh"],
    ["docker exec -it web sh", "docker exec"],
    ["docker run --rm -it alpine", "docker run"],
    ["docker compose exec db psql", "docker compose exec"],
    ["bash", "bash"],
    ["python3", "python3"],
    ["mysql -u root -p", "mysql"],
    ["sudo -i", "sudo"],
    ["sudo su", "su"],
    ["watch docker ps", "watch"],
    ["tmux attach", "tmux"],
    ["cd /tmp && vi notes", "vi"],
  ])("sends %s to the terminal", (line, expected) => {
    expect(prog(line)).toBe(expected);
  });
});
