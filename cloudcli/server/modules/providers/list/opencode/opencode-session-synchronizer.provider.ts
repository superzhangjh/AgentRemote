import { sessionsDb } from '@/modules/database/index.js';
import { createOpenCodeServerClient } from '@/modules/providers/list/opencode/opencode-server.js';
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

const OPENCODE_FALLBACK_TITLE = 'Untitled OpenCode Session';

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

/** Reads a numeric field off the SDK session's `time` object. */
function readSessionTime(session: AnyRecord): { created: number | null; updated: number | null } {
  const time = readObjectRecord(session.time);
  const created = Number(time?.created);
  const updated = Number(time?.updated);
  return {
    created: Number.isFinite(created) ? created : null,
    updated: Number.isFinite(updated) ? updated : null,
  };
}

/**
 * Session indexer for OpenCode's server-backed session store.
 *
 * The server is the authority on which sessions exist, so listings come from
 * the SDK rather than the SQLite file the CLI happens to write.
 */
export class OpenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'opencode' as const;

  /**
   * Scans the OpenCode server and upserts its sessions into DB.
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
   * The file path is ignored: the server already reports every session, and the
   * watcher's change is only a hint that a scan is due.
   */
  async synchronizeFile(_filePath: string): Promise<string | null> {
    const sessions = await this.listSessions(1);
    if (!sessions) {
      return null;
    }

    const result = await this.upsertSessions(sessions, undefined);
    return result.firstSessionId;
  }

  /**
   * Lists root sessions from the server, most recently updated first.
   *
   * Returns null when the server is unreachable so callers can distinguish "no
   * sessions" from "could not scan".
   */
  private async listSessions(limit?: number): Promise<AnyRecord[] | null> {
    try {
      const client = createOpenCodeServerClient();
      const result = await client.session.list(
        { roots: true, ...(limit ? { limit } : {}) },
        { throwOnError: true },
      );
      const data = Array.isArray(result.data) ? result.data : [];
      return data
        .map(readObjectRecord)
        .filter((session): session is AnyRecord => session !== null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCodeProvider] Failed to synchronize sessions:', message);
      return null;
    }
  }

  private async upsertSessions(sessions: AnyRecord[], since?: Date): Promise<SynchronizeRowsResult> {
    const sinceMillis = since?.getTime() ?? null;
    let processed = 0;
    let firstSessionId: string | null = null;

    for (const session of sessions) {
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
      if (sinceMillis !== null && (updated ?? created ?? 0) < sinceMillis) {
        continue;
      }

      const indexedSessionId = await this.upsertSession(session, created, updated);
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
    session: AnyRecord,
    createdAt: number | null,
    updatedAt: number | null,
  ): Promise<string | null> {
    const sessionId = readOptionalString(session.id);
    const projectPath = readOptionalString(session.directory);
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
      nextName = existingName ?? providerTitle ?? await this.readFirstUserText(sessionId, projectPath);
    }

    // OpenCode keeps every session in one server store, so jsonl_path must stay
    // null to avoid deleting shared state when one app session is removed.
    // Return the canonical stored row id so watcher-triggered sidebar updates
    // stay on the app session once provider_session_id has already been mapped.
    return sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, OPENCODE_FALLBACK_TITLE),
      normalizeProviderTimestamp(createdAt),
      normalizeProviderTimestamp(updatedAt ?? createdAt),
      null,
    );
  }

  /** Reads the first user prompt text, used only when the server has no title. */
  private async readFirstUserText(sessionId: string, directory: string): Promise<string | undefined> {
    try {
      const client = createOpenCodeServerClient();
      const result = await client.session.messages(
        { sessionID: sessionId, directory },
        { throwOnError: true },
      );
      const data = Array.isArray(result.data) ? result.data : [];
      for (const entry of data) {
        const info = readObjectRecord(entry?.info);
        if (readOptionalString(info?.role) !== 'user') {
          continue;
        }

        const parts = Array.isArray(entry?.parts) ? entry.parts : [];
        for (const partValue of parts) {
          const part = readObjectRecord(partValue);
          if (readOptionalString(part?.type) !== 'text') {
            continue;
          }

          const text = readOptionalString(part?.text);
          // OpenCode persists the first prompt as a JSON string literal (e.g.
          // `"hello"`), so decode it to avoid titling the session with quotes.
          return text === undefined ? undefined : unwrapJsonStringLiteral(text);
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}
