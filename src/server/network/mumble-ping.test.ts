import { expect, test } from "vitest";
import { parseMumblePong } from "./mumble-ping";

const ident = Buffer.from("0102030405060708", "hex");
const pong = (id: Buffer, patch: number) => Buffer.concat([Buffer.from([0, 1, 5, patch]), id, Buffer.from("00000003000000640001f400", "hex")]);

test("reads Mumble's ping reply, and ignores replies to someone else's ping", () => {
  // Captured shape from mumble-server 1.5.915: the patch byte saturates at 255.
  expect(parseMumblePong(pong(ident, 255), ident)).toEqual({ version: "1.5", users: 3, maxUsers: 100 });
  expect(parseMumblePong(pong(ident, 4), ident)?.version).toBe("1.5.4");
  expect(parseMumblePong(pong(Buffer.alloc(8), 4), ident)).toBeNull();
  expect(parseMumblePong(Buffer.alloc(12), ident)).toBeNull();
});
