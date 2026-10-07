import { describe, expect, it } from "vitest";
import { commandStart, completionContext, quoteWord } from "./tokenize";

const ctx = (line: string, cursor?: number) => {
  const c = completionContext(line, cursor);
  return { words: c.words.map((w) => w.value), current: c.current.value, quote: c.current.openQuote, redirect: c.redirect, start: c.current.start };
};

describe("completionContext", () => {
  it("doesn't split inside quotes or escaped spaces", () => {
    expect(ctx(`cat "My Documents/a b" next`).words).toEqual(["cat", "My Documents/a b"]);
    expect(ctx(`ls My\\ Files/`).current).toBe("My Files/");
    expect(ctx(`echo 'a | b' x`).words).toEqual(["echo", "a | b"]);
  });

  it("keeps an unclosed quote open on the current word", () => {
    const c = ctx(`cat "/etc/my fi`);
    expect(c.current).toBe("/etc/my fi");
    expect(c.quote).toBe('"');
    expect(c.start).toBe(4);
  });

  it("starts a new command after pipes, && and ;", () => {
    expect(ctx("docker ps | grep pro").words).toEqual(["grep"]);
    expect(ctx("cd /tmp && ls -l").words).toEqual(["ls"]);
    expect(ctx("true; systemctl sta").words).toEqual(["systemctl"]);
    expect(ctx("echo $(whoa").words).toEqual([]);
  });

  it("treats the word after a redirect as a file, not an argument", () => {
    const c = ctx("ls > /tmp/ou");
    expect(c.redirect).toBe(true);
    expect(c.words).toEqual(["ls"]);
    expect(ctx("make 2>&1 | tee lo").words).toEqual(["tee"]);
    expect(ctx("cat < in.txt ").words).toEqual(["cat"]);
  });

  it("gives an empty current word after a space", () => {
    const c = ctx("docker ");
    expect(c.words).toEqual(["docker"]);
    expect(c.current).toBe("");
  });

  it("only reads up to the cursor", () => {
    expect(ctx("docker ps -a", 6)).toMatchObject({ words: [], current: "docker" });
  });
});

describe("commandStart", () => {
  it("skips sudo, env assignments and wrappers with their options", () => {
    expect(commandStart(["sudo", "-u", "www", "docker", "ps"])).toBe(3);
    expect(commandStart(["FOO=1", "BAR=2", "make"])).toBe(2);
    expect(commandStart(["timeout", "10", "curl"])).toBe(2);
    expect(commandStart(["nice", "-n", "5", "tar"])).toBe(3);
    expect(commandStart(["docker", "ps"])).toBe(0);
  });
});

describe("quoteWord", () => {
  it("escapes what the shell would split or expand", () => {
    expect(quoteWord("My Files/", null)).toBe("My\\ Files/");
    expect(quoteWord("a$b", null)).toBe("a\\$b");
    expect(quoteWord("it's", "'")).toBe("it'\\''s");
    expect(quoteWord('say "hi"', '"')).toBe('say \\"hi\\"');
    expect(quoteWord("/etc/nginx.conf", null)).toBe("/etc/nginx.conf");
  });
});
