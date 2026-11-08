import "server-only";
import { every, onStart } from "../jobs";
import { syncVoiceCertificates } from "./certs";

onStart("voice-certs", () => {
  setTimeout(() => void syncVoiceCertificates().catch(() => undefined), 75_000).unref?.();
  every(15 * 60_000, () => syncVoiceCertificates({ onlyDue: true }));
});
