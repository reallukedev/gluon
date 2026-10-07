import { describe, expect, test } from "vitest";
import { splitServer, xmppText } from "./xmpp-format";

describe("what an XMPP notification says", () => {
  test("a problem is its title, the first line of the explanation and the link, as plain text", () => {
    const text = xmppText({
      title: "Jellyfin isn't answering",
      body: "Its container keeps restarting.\n\nFix: Restart Jellyfin (one tap in Gluon).",
      link: "https://gluon.example/status#app.broken%3Ajellyfin",
      event: "problem",
    });
    expect(text).toBe("Jellyfin isn't answering\nIts container keeps restarting.\nhttps://gluon.example/status#app.broken%3Ajellyfin");
    expect(text).not.toMatch(/<|&lt;/);
  });

  test("a batch keeps a few of its list lines, and a long line is cut", () => {
    const body = Array.from({ length: 9 }, (_, i) => `• Problem ${i + 1}`).join("\n");
    const lines = xmppText({ title: "9 problems on leech", body, link: null, event: "problem" }).split("\n");
    expect(lines).toEqual(["9 problems on leech", "• Problem 1", "• Problem 2", "• Problem 3", "• Problem 4", "• Problem 5", "• Problem 6", "…"]);
    const long = xmppText({ title: "t", body: "x".repeat(1000), link: null, event: "update" });
    expect(long.split("\n")[1]!.length).toBeLessThanOrEqual(280);
  });
});

describe("the server address of an XMPP account", () => {
  test.each([
    ["chat.example.com", { host: "chat.example.com", port: 5222 }],
    ["chat.example.com:5223", { host: "chat.example.com", port: 5223 }],
    ["[2001:db8::1]:5222", { host: "2001:db8::1", port: 5222 }],
    ["https://chat.example.com", null],
    ["chat.example.com:99999", null],
    ["", null],
  ])("%s", (input, want) => expect(splitServer(input)).toEqual(want));
});
