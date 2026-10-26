/**
 * decideCopy (shared with chat servers) words its reasons for a chat server. The decision is the
 * same for Mumble; only the nouns change. Pure.
 */
export function voiceReason(reason: string): string {
  return reason
    .replace(/\bThe chat server's own certificate\b/g, "Mumble's own certificate")
    .replace(/\bThe chat server's\b/g, "Mumble's")
    .replace(/\bthe chat server's\b/g, "Mumble's")
    .replace(/\bThe chat server\b/g, "Mumble")
    .replace(/\bthe chat server\b/g, "Mumble")
    .replace(/\bchat apps\b/g, "Mumble apps");
}
