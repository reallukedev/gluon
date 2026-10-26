/**
 * Mumble's ping reply: version (4 bytes: 0, major, minor, patch), the 8-byte ident we sent, then
 * users online, the user limit and allowed bandwidth (4 bytes each, big-endian). Null when it isn't
 * a reply to our ping. Patch numbers past 254 don't fit in a byte (1.5.915 sends 255), so those are left off.
 */
export function parseMumblePong(msg: Buffer, ident: Buffer): { version: string; users: number; maxUsers: number } | null {
  if (msg.length < 24 || !msg.subarray(4, 12).equals(ident)) return null;
  return { version: msg[3] === 255 ? `${msg[1]}.${msg[2]}` : `${msg[1]}.${msg[2]}.${msg[3]}`, users: msg.readUInt32BE(12), maxUsers: msg.readUInt32BE(16) };
}
