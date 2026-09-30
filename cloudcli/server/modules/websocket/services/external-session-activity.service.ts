import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Sessions a provider runtime is running outside CloudCLI — today, OpenCode
 * sessions started by the desktop app or CLI that the OpenCode server reports
 * as `busy`.
 *
 * CloudCLI's own runs live in the chat run registry; this map is the parallel
 * source of truth for externally-owned runs. Both feed the same
 * `session_activity` delta and the running-sessions API so the sidebar shows a
 * spinner for every provider, no matter who started the turn.
 */
type ExternalBusySession = {
  provider: LLMProvider;
  /** Short human-readable phase ("正在处理任务", "等待审批", ...), or null. */
  statusText: string | null;
};

const externalBusySessions = new Map<string, ExternalBusySession>();

/** Broadcasts one activity flip to every open chat socket. */
export function broadcastSessionActivity(
  sessionId: string,
  isProcessing: boolean,
  statusText: string | null = null,
): void {
  const payload = JSON.stringify({
    kind: 'session_activity',
    sessionId,
    isProcessing,
    statusText: isProcessing ? statusText : null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

/**
 * Records an externally-owned run's activity, broadcasting when the busy flag
 * or the phase label changes so repeated status frames do not spam clients.
 */
export function setExternalSessionActivity(
  sessionId: string,
  provider: LLMProvider,
  isProcessing: boolean,
  statusText: string | null = null,
): void {
  if (!sessionId) {
    return;
  }

  const previous = externalBusySessions.get(sessionId);
  const nextStatusText = isProcessing ? statusText : null;
  if (isProcessing) {
    externalBusySessions.set(sessionId, { provider, statusText: nextStatusText });
  } else {
    externalBusySessions.delete(sessionId);
  }

  const wasBusy = Boolean(previous);
  if (wasBusy !== isProcessing || (previous?.statusText ?? null) !== nextStatusText) {
    broadcastSessionActivity(sessionId, isProcessing, nextStatusText);
  }
}

/** Snapshot of every externally-owned running session, consumed by the running-sessions API. */
export function listExternalBusySessions(): Array<{
  sessionId: string;
  provider: LLMProvider;
  statusText: string | null;
}> {
  return Array.from(externalBusySessions.entries()).map(([sessionId, entry]) => ({
    sessionId,
    provider: entry.provider,
    statusText: entry.statusText,
  }));
}

/** True when a specific session is running outside CloudCLI. */
export function isExternalSessionBusy(sessionId: string): boolean {
  return externalBusySessions.has(sessionId);
}

/** Drops all external activity state, used when the bridge stops or reconnects. */
export function clearExternalSessionActivity(): void {
  externalBusySessions.clear();
}
