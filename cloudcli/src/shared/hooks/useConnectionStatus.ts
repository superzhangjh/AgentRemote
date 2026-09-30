import { useCallback, useEffect, useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';

/**
 * `connected`  — the chat socket is open; nothing to do.
 * `connecting` — the socket is opening, reconnecting, or the tab was just
 *                resumed and the socket has not proven itself yet.
 * `offline`    — the device has no network, so no reconnect can succeed.
 */
export type ConnectionState = 'connected' | 'connecting' | 'offline';

export type ConnectionStatus = {
  state: ConnectionState;
  /** Browser-level network state, false when the phone has no Wi-Fi or data at all. */
  isOnline: boolean;
  /** Version reported by `/health`, when the last probe reached the server. */
  serverVersion: string | null;
  /** Round-trip time of the last successful health probe, in milliseconds. */
  latencyMs: number | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  /** Closes the socket so the reconnect path runs now instead of on the timer. */
  retry: () => void;
};

const HEALTH_PROBE_INTERVAL_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the app can currently reach its CloudCLI server, for the connection
 * indicator in the sidebar and the banner above the workspace tabs.
 *
 * Two independent signals: the websocket (the transport everything realtime
 * travels on) and `/health` (proof the HTTP side answers, plus the version and
 * a latency number to show in the tooltip). The socket decides the state — a
 * `/health` response alone would call a dead realtime connection "connected".
 */
export function useConnectionStatus(): ConnectionStatus {
  const { isConnected, reconnect } = useWebSocket();
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const probeHealth = useCallback(async () => {
    setIsChecking(true);
    const startedAt = Date.now();
    try {
      // The cache-busting parameter keeps the service worker out of the way:
      // this probe must reach the server, not a cached response.
      const response = await fetch(`/health?t=${startedAt}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { version?: unknown };
      setLatencyMs(Date.now() - startedAt);
      setServerVersion(typeof payload.version === 'string' ? payload.version : null);
    } catch {
      // The socket state is the source of truth; a failed probe only means the
      // tooltip has nothing fresh to show.
      setLatencyMs(null);
    } finally {
      setLastCheckedAt(Date.now());
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void probeHealth();
    const interval = window.setInterval(() => {
      void probeHealth();
    }, HEALTH_PROBE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [probeHealth]);

  // Coming back from the background is exactly when a stale indicator would
  // lie the longest, so re-probe immediately and then let the socket catch up.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void probeHealth();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('agentremote:resume', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('agentremote:resume', onVisible);
    };
  }, [probeHealth]);

  const retry = useCallback(() => {
    void probeHealth();
    reconnect();
  }, [probeHealth, reconnect]);

  const state: ConnectionState = !isOnline
    ? 'offline'
    : isConnected
      ? 'connected'
      : 'connecting';

  return {
    state,
    isOnline,
    serverVersion,
    latencyMs,
    lastCheckedAt,
    isChecking,
    retry,
  };
}
