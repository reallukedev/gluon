import "server-only";
import crypto from "node:crypto";
import { arr, client, obj, str, UpstreamError, type KindContext } from "./kinds/base";
import { KINDS } from "./registry";
import { badRequest } from "../errors";
import type { SignInKind } from "@/lib/widgets-types";

/**
 * "Sign in with your <App> account": Gluon signs in once with the person's username and password, asks the app
 * to make an API key named "Gluon", signs out again and keeps only the key. The password is never stored or logged.
 */

export const KEY_NAME = "Gluon";

/** Read-only permissions the Immich widget uses (statistics, memories, thumbnails). */
const IMMICH_PERMISSIONS = ["server.statistics", "server.about", "asset.statistics", "asset.read", "asset.view", "memory.read", "user.read", "timeline.read"];

export interface Minted {
  apiKey: string;
  /** Who Gluon signed in as, for messages and the audit log. */
  account: string;
}

function ctxFor(kind: SignInKind, baseUrl: string, allowSelfSigned: boolean): KindContext<Record<string, unknown>> {
  return {
    id: null,
    name: "sign-in",
    baseUrl,
    config: { apiKey: "", userId: null, allowSelfSigned },
    version: Date.now(),
  };
}

function parse(body: Buffer): Record<string, unknown> {
  try {
    return obj(JSON.parse(body.toString("utf8")));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ Jellyfin

async function jellyfin(baseUrl: string, username: string, password: string, allowSelfSigned: boolean): Promise<Minted> {
  const ctx = ctxFor("jellyfin", baseUrl, allowSelfSigned);
  const h = client(KINDS.jellyfin, ctx, () => null);
  const device = `gluon-signin-${crypto.randomBytes(6).toString("hex")}`;
  const base = `MediaBrowser Client="Gluon", Device="Gluon", DeviceId="${device}", Version="1.0"`;

  const login = await h.raw("/Users/AuthenticateByName", {
    method: "POST",
    body: { Username: username, Pw: password },
    headers: { Authorization: base },
    noAuth: true,
    allow: [400, 401, 403],
  });
  if (login.status === 401 || login.status === 403 || login.status === 400) {
    throw new UpstreamError("Jellyfin didn't accept that username and password.", login.status, "upstream_auth");
  }
  const auth = parse(login.body);
  const token = str(auth.AccessToken);
  if (!token) throw new UpstreamError("Jellyfin answered the sign-in, but didn't hand out a session. Check the address points at Jellyfin.");
  const user = obj(auth.User);
  const account = str(user.Name) ?? username;
  const headers = {
    Authorization: `${base}, Token="${token.replace(/"/g, "")}"`,
  };

  try {
    if (obj(user.Policy).IsAdministrator !== true) {
      throw new UpstreamError(
        `“${account}” isn't a Jellyfin administrator, and only administrators can make API keys. Sign in as one, or paste a key instead.`,
        403,
        "upstream_auth",
      );
    }
    // Jellyfin's "create key" answers 204 without the key, so compare the list before and after.
    const listKeys = async () =>
      arr<Record<string, unknown>>(parse((await h.raw("/Auth/Keys", { headers, noAuth: true })).body).Items)
        .map((k) => ({
          token: str(k.AccessToken),
          app: str(k.AppName),
          created: Date.parse(String(k.DateCreated ?? "")) || 0,
        }))
        .filter((k): k is { token: string; app: string | null; created: number } => !!k.token);
    const before = new Set((await listKeys()).map((k) => k.token));
    await h.raw("/Auth/Keys", {
      method: "POST",
      query: { app: KEY_NAME },
      headers,
      noAuth: true,
    });
    const made = (await listKeys()).filter((k) => !before.has(k.token) && k.app === KEY_NAME).sort((a, b) => b.created - a.created)[0];
    if (!made) throw new UpstreamError("Jellyfin said it made the key, but it isn't in its list. Try again, or paste a key instead.");
    return { apiKey: made.token, account };
  } finally {
    // End the temporary session; the key lives on its own.
    await h
      .raw("/Sessions/Logout", {
        method: "POST",
        headers,
        noAuth: true,
        allow: [401, 403, 404],
      })
      .catch(() => undefined);
  }
}

// ------------------------------------------------------------------ Immich

async function immich(baseUrl: string, email: string, password: string, allowSelfSigned: boolean): Promise<Minted> {
  if (!email.includes("@")) throw badRequest("Immich signs in with an email address. Enter the email you use for Immich.", { field: "username" });
  const ctx = ctxFor("immich", baseUrl, allowSelfSigned);
  const h = client(KINDS.immich, ctx, () => null);
  const login = await h.raw("/api/auth/login", {
    method: "POST",
    body: { email, password },
    noAuth: true,
    allow: [400, 401, 403],
  });
  if (login.status >= 400) {
    throw new UpstreamError("Immich didn't accept that email and password.", login.status, "upstream_auth");
  }
  const auth = parse(login.body);
  const token = str(auth.accessToken);
  if (!token) throw new UpstreamError("Immich answered the sign-in, but didn't hand out a session. Check the address points at Immich.");
  const account = str(auth.name) ?? str(auth.userEmail) ?? email;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const res = await h.raw("/api/api-keys", {
      method: "POST",
      headers,
      noAuth: true,
      body: { name: KEY_NAME, permissions: IMMICH_PERMISSIONS },
      allow: [400, 403],
    });
    if (res.status >= 400) {
      throw new UpstreamError(`Immich wouldn't make a key for “${account}” (${res.status}). Paste a key made in Immich instead.`, res.status);
    }
    const secret = str(parse(res.body).secret);
    if (!secret) throw new UpstreamError("Immich made the key but didn't return it. Paste a key made in Immich instead.");
    return { apiKey: secret, account };
  } finally {
    await h
      .raw("/api/auth/logout", {
        method: "POST",
        headers,
        noAuth: true,
        body: {},
        allow: [401, 403, 404],
      })
      .catch(() => undefined);
  }
}

export function mintKey(kind: SignInKind, baseUrl: string, username: string, password: string, allowSelfSigned = false): Promise<Minted> {
  return kind === "jellyfin" ? jellyfin(baseUrl, username, password, allowSelfSigned) : immich(baseUrl, username, password, allowSelfSigned);
}
