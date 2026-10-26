import "server-only";
import { every, onStart } from "../jobs";
import { syncVoiceCertificates } from "./certs";

/** Voice servers that follow an address's certificate: checked with the chat servers' rhythm. */
onStart("voice-certs", () => {
  setTimeout(() => void syncVoiceCertificates().catch(() => undefined), 75_000).unref?.();
  every(15 * 60_000, () => syncVoiceCertificates({ onlyDue: true }));
});
