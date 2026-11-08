import { describe, expect, test } from "vitest";
import { judge, type Fetched } from "./login-probe";

const page = (body: string, extra: Partial<Fetched> = {}): Fetched => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body, location: null, url: "http://192.168.1.20:3000/", ...extra });

describe("judging an app's home page", () => {
  test("a dashboard that links to apps with logins is still a page anyone can open", () => {
    const body = `<!doctype html><html><head><title>Home</title></head><body>
      <a href="http://192.168.1.20:8096">Jellyfin</a> <a href="http://192.168.1.20:32400">Plex</a>
      <a href="http://192.168.1.20:8123">Home Assistant</a> ${"<p>tile</p>".repeat(800)}</body></html>`;
    expect(judge(page(body))).toMatchObject({ result: "none", fingerprint: null });
  });

  test("an app is recognised by its title or the meta tags that name it", () => {
    expect(judge(page("<html><head><title>Jellyfin</title></head><body><div id=x></div></body></html>"))).toMatchObject({ result: "login", fingerprint: "Jellyfin" });
    const gitea = `<html><head><title>Code</title><meta name="author" content="Gitea - Git with a cup of tea"></head><body>${"<p>repo</p>".repeat(900)}</body></html>`;
    expect(judge(page(gitea))).toMatchObject({ result: "login", fingerprint: "Gitea" });
  });

  test("a password field or a sign-in redirect means a login, whatever the app", () => {
    expect(judge(page('<form><input type="password" name="p"></form>'))).toMatchObject({ result: "login" });
    expect(judge(page("", { status: 302, location: "/login?next=/" }))).toMatchObject({ result: "login" });
  });
});
