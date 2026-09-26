import "server-only";
import type { User } from "./auth/users";

export interface SearchGroup {
  name: string;
  items: { id: string; label: string; hint?: string; icon?: string; href?: string; external?: boolean }[];
}

type Provider = (user: User, q: string) => Promise<SearchGroup | null> | SearchGroup | null;
// On globalThis: providers register from instrumentation's module graph, but route handlers are
// bundled separately and would otherwise see an empty list.
const g = globalThis as { __gluonSearchProviders?: Provider[] };
const providers: Provider[] = (g.__gluonSearchProviders ??= []);

/** Feature modules register a provider (apps, files, disks, people…). */
export function registerSearch(p: Provider) {
  providers.push(p);
}

export async function searchAll(user: User, q: string): Promise<{ groups: SearchGroup[] }> {
  const term = q.trim();
  if (term.length < 2) return { groups: [] };
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p(user, term);
      } catch {
        return null;
      }
    }),
  );
  return { groups: results.filter((g): g is SearchGroup => !!g && g.items.length > 0) };
}
