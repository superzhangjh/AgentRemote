import type { LLMProvider, Project } from '@/shared/types';

/**
 * Bump when the cached `Project`/`ProjectSession` shape changes so entries
 * written by an older frontend are ignored instead of crashing the renderer.
 */
const PROJECTS_CACHE_VERSION = 1;

/** Most sessions kept per project in the snapshot, so one huge project cannot exhaust the storage quota. */
const MAX_CACHED_SESSIONS_PER_PROJECT = 100;

const cacheKey = (provider: LLMProvider): string =>
  `cloudcli-projects-cache-v${PROJECTS_CACHE_VERSION}-${provider}`;

/** Trims the snapshot to the fields the sidebar needs before persisting. */
const toPersistableProjects = (projects: Project[]): Project[] =>
  projects.map((project) => ({
    ...project,
    sessions: Array.isArray(project.sessions)
      ? project.sessions.slice(0, MAX_CACHED_SESSIONS_PER_PROJECT)
      : project.sessions,
  }));

/**
 * Reads the last project/session snapshot for one provider.
 *
 * Used by `useProjectsState` to seed the sidebar from localStorage so a slow
 * connection (for example a phone over Tailscale) paints the session list
 * immediately while `/api/projects` is still in flight. Returns an empty array
 * when nothing valid is cached or storage is unavailable.
 */
export function readCachedProjects(provider: LLMProvider): Project[] {
  try {
    const raw = localStorage.getItem(cacheKey(provider));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Older builds could store the outgoing agent's list under the incoming
    // agent's key during a provider switch. Drop that poisoned snapshot.
    return parsed.some((project: Project) =>
      project.sessions?.some((session) =>
        (session.__provider ?? session.provider) &&
        (session.__provider ?? session.provider) !== provider,
      ),
    ) ? [] : parsed as Project[];
  } catch {
    return [];
  }
}

/**
 * Persists the latest project/session snapshot for one provider.
 *
 * An empty list clears the snapshot instead of keeping the previous one, so a
 * session or project deleted locally cannot be resurrected from a stale cache
 * on the next cold start.
 *
 * Best-effort: quota errors and unavailable storage are swallowed because the
 * cache only accelerates the next paint and never replaces the network result.
 */
export function writeCachedProjects(provider: LLMProvider, projects: Project[]): void {
  try {
    if (!Array.isArray(projects) || projects.length === 0) {
      localStorage.removeItem(cacheKey(provider));
      return;
    }

    localStorage.setItem(cacheKey(provider), JSON.stringify(toPersistableProjects(projects)));
  } catch {
    // Ignore quota and serialization errors; the network result remains authoritative.
  }
}
