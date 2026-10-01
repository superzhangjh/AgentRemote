import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  createOpenCodeServerClients,
  type OpenCodeServer,
} from '@/modules/providers/list/opencode/opencode-server.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  normalizeProviderTimestamp,
  normalizeSessionName,
  readObjectRecord,
  readOptionalString,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

type SynchronizeRowsResult = {
  processed: number;
  firstSessionId: string | null;
};

/** One discovered session plus the server that owns it, for follow-up reads. */
type DiscoveredSession = {
  session: AnyRecord;
  server: OpenCodeServer;
};

const OPENCODE_FALLBACK_TITLE = 'Untitled OpenCode Session';
/** Safety bound on session-list pagination so a bad cursor cannot loop forever. */
const MAX_LIST_PAGES = 50;

/**
 * OpenCode seeds every new session with the placeholder title
 * `New session - <ISO timestamp>` until the first turn finishes and it writes a
 * real title. A stored placeholder (or a missing/fallback title) must not
 * outrank the title OpenCode later generates, or the sidebar keeps showing the
 * creation timestamp forever.
 */
function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  if (!title || title === OPENCODE_FALLBACK_TITLE) {
    return true;
  }

  return /^New session\b/.test(title.trim());
}

/** Reads a numeric field off a session's `time` object. */
function readSessionTime(session: AnyRecord): { created: number | null; updated: number | null } {
  const time = readObjectRecord(session.time);
  const created = Number(time?.created);
  const updated = Number(time?.updated);
  return {
    created: Number.isFinite(created) ? created : null,
    updated: Number.isFinite(updated) ? updated : null,
  };
}

/** Most-recent activity timestamp, used to order merged multi-server listings. */
function readSessionUpdatedAt(session: AnyRecord): number {
  const { created, updated } = readSessionTime(session);
  return updated ?? created ?? 0;
}

/**
 * Directory a session belongs to.
 *
 * The v2 API nests it under `location.directory`; the 1.18 compatibility shape
 * exposes it top-level - both are accepted.
 */
function readSessionDirectory(session: AnyRecord): string | null {
  return readOptionalString(readObjectRecord(session.location)?.directory)
    ?? readOptionalString(session.directory)
    ?? null;
}

/**
 * Whether a session's working directory is one of the OpenCode CLI's internal
 * probe directories.
 *
 * The CLI runs liveness/permission probes as real sessions - `opencode-cli-live-*`
 * and `opencode-cli-perms-*` directly under the system temp root - and every
 * server lists them like user conversations. Their directories vanish when the
 * CLI exits, and asking a server for approvals scoped to those dead paths
 * answers HTTP 500 every poll, so they must never become app projects.
 */
function isInternalProbeSessionDirectory(directory: string): boolean {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`)) {
    return false;
  }

  return path.basename(resolved).startsWith('opencode-cli-');
}

/**
 * Session indexer for OpenCode's server-backed session store.
 *
 * Every discoverable server is scanned with the v2 API, which both 1.18 and 2.0
 * expose and which lists sessions across all projects. That keeps a session
 * started in the desktop app visible on the phone even though the console runs
 * a separate `opencode serve` process. Sessions the index has not seen yet are
 * imported unconditionally, so a scan that missed one - an unreachable server,
 * a restart between scans - self-heals on the next run.
 */
export class OpenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'opencode' as const;

  /**
   * Scans every OpenCode server and upserts its sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const sessions = await this.listSessions();
    if (!sessions) {
      return 0;
    }

    const result = await this.upsertSessions(sessions, since);
    return result.processed;
  }

  /**
   * Handles watcher changes by indexing the most recently updated session.
   *
   * The file path is ignored: the servers already report every session, and the
   * watcher's change is only a hint that a scan is due.
   */
  async synchronizeFile(_filePath: string): Promise<string | null> {
    const sessions = await this.listSessions(1);
    if (!sessions || sessions.length === 0) {
      return null;
    }

    // Only the globally most recent session belongs to this change; the
    // per-server `limit` above already narrowed the candidates.
    const result = await this.upsertSessions(sessions.slice(0, 1), undefined);
    return result.firstSessionId;
  }

  /**
   * Lists root sessions from every discovered server, most recently updated
   * first. Returns null when no server answered, so callers can distinguish
   * "no sessions" from "could not scan".
   */
  private async listSessions(limitPerServer?: number): Promise<DiscoveredSession[] | null> {
    const servers = createOpenCodeServerClients();
    const byId = new Map<string, DiscoveredSession>();
    let reached = 0;

    for (const server of servers) {
      try {
        const sessions = await this.listServerSessions(server, limitPerServer);
        reached += 1;
        for (const session of sessions) {
          const sessionId = readOptionalString(session.id);
          if (sessionId && !byId.has(sessionId)) {
            byId.set(sessionId, { session, server });
          }
        }
      } catch {
        // A server that is down or rejects the request contributes nothing;
        // the others still do.
      }
    }

    if (reached === 0) {
      console.warn('[OpenCodeProvider] Failed to synchronize sessions: no OpenCode server reachable.');
      return null;
    }

    return [...byId.values()].sort(
      (left, right) => readSessionUpdatedAt(right.session) - readSessionUpdatedAt(left.session),
    );
  }

  /** Reads one server's session list, following its cursor until exhausted. */
  private async listServerSessions(server: OpenCodeServer, limit?: number): Promise<AnyRecord[]> {
    const collected: AnyRecord[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await server.client.v2.session.list(
        { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) },
        { throwOnError: true },
      );
      const body = readObjectRecord(result.data) ?? {};
      for (const value of Array.isArray(body.data) ? body.data : []) {
        const session = readObjectRecord(value);
        if (session) {
          collected.push(session);
        }
      }

      cursor = readOptionalString(readObjectRecord(body.cursor)?.next) ?? undefined;
      if (!cursor || (limit && collected.length >= limit)) {
        break;
      }
    }

    return limit ? collected.slice(0, limit) : collected;
  }

  private async upsertSessions(
    discovered: DiscoveredSession[],
    since?: Date,
  ): Promise<SynchronizeRowsResult> {
    const sinceMillis = since?.getTime() ?? null;
    let processed = 0;
    let firstSessionId: string | null = null;

    for (const entry of discovered) {
      const { session } = entry;
      // Subagent runs create child sessions (`parentID` set). They are internal
      // task branches, not conversations the user started, so indexing them
      // adds phantom sidebar entries that look like duplicate sessions.
      if (readOptionalString(session.parentID)) {
        continue;
      }

      const { created, updated } = readSessionTime(session);
      if (readObjectRecord(session.time)?.archived != null) {
        continue;
      }

      const sessionDirectory = readSessionDirectory(session);
      if (sessionDirectory && isInternalProbeSessionDirectory(sessionDirectory)) {
        continue;
      }

      const sessionId = readOptionalString(session.id);
      if (sessionId && sessionsDb.isProviderSessionSuperseded(sessionId, this.provider)) {
        // The user deleted this conversation in CloudCLI. The server keeps
        // listing it, so only the tombstone keeps the indexer from importing
        // the deleted conversation back into the sidebar.
        continue;
      }

      // The scan cursor only gates *refreshes* of sessions the index already
      // knows. A session the index has never seen is imported no matter how
      // old it is: scans that ran while its server was unreachable skipped it
      // while still advancing `scan_state.last_scanned_at`, and the cursor
      // never moves back, so it would stay invisible on the phone forever.
      const indexedSession = sessionId
        ? sessionsDb.getSessionByProviderSessionId(sessionId, this.provider)
          ?? sessionsDb.getSessionById(sessionId, this.provider)
        : null;
      if (sinceMillis !== null && indexedSession && (updated ?? created ?? 0) < sinceMillis) {
        continue;
      }

      const indexedSessionId = await this.upsertSession(entry, created, updated);
      if (!indexedSessionId) {
        continue;
      }

      if (!firstSessionId) {
        firstSessionId = indexedSessionId;
      }
      processed += 1;
    }

    return { processed, firstSessionId };
  }

  private async upsertSession(
    entry: DiscoveredSession,
    createdAt: number | null,
    updatedAt: number | null,
  ): Promise<string | null> {
    const { session, server } = entry;
    const sessionId = readOptionalString(session.id);
    const projectPath = readSessionDirectory(session);
    if (!sessionId || !projectPath) {
      return null;
    }

    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId, this.provider)
      ?? sessionsDb.getSessionById(sessionId, this.provider)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // Slow networks can let the watcher index a session before the runtime
      // reports its provider id back through the websocket mapping. Bind that
      // id to the fresh app row first so the watcher does not create a
      // temporary provider-id sidebar entry for the same session.
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    // App-created sessions are keyed by an app id, so server-discovered
    // provider ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId, this.provider)
      ?? sessionsDb.getSessionById(sessionId, this.provider);
    const existingName = existingSession?.custom_name;
    const providerTitle = readOptionalString(session.title);

    let nextName: string | undefined;
    if (existingName && !isPlaceholderSessionTitle(existingName)) {
      // A real CloudCLI/user title already exists; never overwrite it.
      nextName = existingName;
    } else if (providerTitle && !isPlaceholderSessionTitle(providerTitle)) {
      // The placeholder indexed at creation time is now superseded by the
      // title OpenCode generated once the first turn completed.
      nextName = providerTitle;
    } else {
      nextName = existingName ?? providerTitle ?? await this.readFirstUserText(server, sessionId);
    }

    // OpenCode keeps every session in one server store, so jsonl_path must stay
    // null to avoid deleting shared state when one app session is removed.
    // Return the canonical stored row id so watcher-triggered sidebar updates
    // stay on the app session once provider_session_id has already been mapped.
    const appSessionId = sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, OPENCODE_FALLBACK_TITLE),
      normalizeProviderTimestamp(createdAt),
      normalizeProviderTimestamp(updatedAt ?? createdAt),
      null,
    );
    sessionsDb.pinOpenCodeServer(appSessionId, server.config.id ?? server.config.url);
    return appSessionId;
  }

  /** Reads the first user prompt text, used only when a session has no title. */
  private async readFirstUserText(server: OpenCodeServer, sessionId: string): Promise<string | undefined> {
    try {
      const result = await server.client.v2.session.messages(
        { sessionID: sessionId },
        { throwOnError: true },
      );
      const body = readObjectRecord(result.data) ?? {};
      for (const value of Array.isArray(body.data) ? body.data : []) {
        const message = readObjectRecord(value);
        if (readOptionalString(message?.type) !== 'user') {
          continue;
        }

        const text = readOptionalString(message?.text);
        // OpenCode persists the first prompt as a JSON string literal (e.g.
        // `"hello"`), so decode it to avoid titling the session with quotes.
        return text === undefined ? undefined : unwrapJsonStringLiteral(text);
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}
