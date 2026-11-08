import { describe, expect, it } from "vitest";
import { envLine, parseEnvFile } from "./vars";

// Checked against `docker compose config` (compose-go dotenv parser).
describe("envLine for compose", () => {
  it("double-quotes a value ending in a backslash, which compose can't read single-quoted", () => {
    expect(envLine("K", "C:\\path\\")).toBe('K="C:\\\\path\\\\"');
    expect(parseEnvFile(envLine("K", "C:\\path\\")).K).toBe("C:\\path\\");
  });

  it("keeps a lone carriage return", () => {
    expect(envLine("K", "a\rb")).toBe('K="a\\rb"');
    expect(parseEnvFile(envLine("K", "a\rb")).K).toBe("a\rb");
  });
});

describe("parseEnvFile double quotes", () => {
  it("reads the escapes compose reads and leaves others as written", () => {
    expect(parseEnvFile('K="a\\tb\\rc\\qd"').K).toBe("a\tb\rc\\qd");
  });
});
