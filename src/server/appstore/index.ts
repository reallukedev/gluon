import "server-only";
import { every, onStart } from "../jobs";
import { failInterruptedBuilds, listAppRows, saveGithub, readSecrets, ensureSchema } from "./db";
import { latestCommit } from "./github";
import { isRunning } from "./jobs";

/**
 * The app builder's background work: builds cut short by a restart are marked failed, and apps
 * from GitHub are checked for new commits a few times a day so the list can say "new commits".
 */
onStart("app builder", () => {
  ensureSchema();
  failInterruptedBuilds();
  every(
    6 * 60 * 60_000,
    async () => {
      for (const a of listAppRows()) {
        if (!a.github || a.status !== "published" || isRunning(a.id)) continue;
        try {
          const latest = await latestCommit(a.github, readSecrets(a.id).githubToken);
          saveGithub(a.id, { ...a.github, latestCommit: latest, checkedAt: Date.now() });
        } catch {
          /* offline, rate limited, token expired: the Source tab says so when asked */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
    { immediate: false },
  );
});

export {};
