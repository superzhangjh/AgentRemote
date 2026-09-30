import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { IsSessionProcessing, MarkSessionIdle, MarkSessionProcessing, SessionActivityMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const AwaitingInputSessionIdsContext = createContext<ReadonlySet<string> | null>(null);

/**
 * The set of session ids currently producing a response, with a stable identity
 * while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useBusySessionIds(processingSessions: SessionActivityMap): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions.keys()].sort().join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

/**
 * The phase labels a run reports while it is blocked on the user.
 *
 * These are the exact strings the chat gateway and the OpenCode bridge put in
 * `statusText`; the sidebar needs them to colour "等待审批/等待回答" differently
 * from a run that is simply working. Kept next to the set below so the two
 * places that must agree are in one file.
 */
const AWAITING_INPUT_STATUS_TEXTS = ['等待审批', '等待回答'];

export const isAwaitingInputStatusText = (statusText: string | null | undefined): boolean =>
  typeof statusText === 'string' && AWAITING_INPUT_STATUS_TEXTS.includes(statusText);

/**
 * Sessions whose run is waiting on the user (a tool approval or a question),
 * with the same stable identity guarantee as `useBusySessionIds`.
 */
function useAwaitingInputSessionIds(processingSessions: SessionActivityMap): ReadonlySet<string> {
  const membershipKey = [...processingSessions.entries()]
    .filter(([, activity]) => isAwaitingInputStatusText(activity.statusText))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Mounted by the project-workspace route; tracks which sessions are producing a response so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({
  children,
  sessionId,
}: {
  children: ReactNode;
  sessionId?: string;
}) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    isSessionProcessing,
  } = useSessionProtection();

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions(sessionId);
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [sessionId, syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  // A WebView that came back to the foreground can be minutes behind the 5s
  // poll, so catch up immediately instead of leaving a stale activity
  // indicator until the next tick.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshRunningSessions();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      syncProcessingSessions,
      isSessionProcessing,
    }),
    [
      isSessionProcessing,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useBusySessionIds(processingSessions);
  const awaitingInputSessionIds = useAwaitingInputSessionIds(processingSessions);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <AwaitingInputSessionIdsContext.Provider value={awaitingInputSessionIds}>
          <SessionProtectionStateContext.Provider value={processingSessions}>
            {children}
          </SessionProtectionStateContext.Provider>
        </AwaitingInputSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the running sessions. Prefer this over
 * useProcessingSessions wherever the activity details are not rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * Sessions waiting on the user right now (tool approval or a question), for the
 * sidebar's blue state.
 */
export function useAwaitingInputSessionIdSet(): ReadonlySet<string> {
  const awaitingInputSessionIds = useContext(AwaitingInputSessionIdsContext);
  if (!awaitingInputSessionIds) {
    throw new Error('useAwaitingInputSessionIdSet must be used within SessionProtectionProvider');
  }
  return awaitingInputSessionIds;
}

export function useProcessingSessions(): SessionActivityMap {  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
