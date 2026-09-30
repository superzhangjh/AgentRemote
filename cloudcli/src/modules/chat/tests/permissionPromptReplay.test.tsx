import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession, PendingPermissionRequest, LLMProvider } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Answering a permission prompt resolves it over the inbound socket only, but
 * the `permission_request` frame stays in the run's replay buffer. A mid-run
 * page refresh replays the whole buffer, so without a retracting
 * `permission_resolved` frame the already-answered prompt resurrected on every
 * refresh (and lingered forever in a second tab watching the same run).
 */

const renderHandlers = (provider: LLMProvider = 'claude') => {
  let listener: ((event: ServerEvent) => void) | null = null;
  let pending: PendingPermissionRequest[] = [];
  const processing: unknown[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider,
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: (next) => {
      pending = typeof next === 'function' ? next(pending) : next;
    },
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    onSessionProcessing: (sessionId, options) => processing.push({ sessionId, ...options }),
    sessionStore: { appendRealtime: () => {} } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, getPending: () => pending, processing };
};

const requestEvent = (requestId: string, seq: number): ServerEvent => ({
  kind: 'permission_request',
  requestId,
  toolName: 'AskUserQuestion',
  input: { questions: [] },
  sessionId: 'viewed-session',
  seq,
} as unknown as ServerEvent);

const resolvedEvent = (requestId: string, seq: number): ServerEvent => ({
  kind: 'permission_resolved',
  requestId,
  sessionId: 'viewed-session',
  seq,
} as unknown as ServerEvent);

test('a replayed request followed by its resolution leaves no pending prompt', () => {
  const { dispatch, getPending } = renderHandlers();

  // Reconnect after a mid-run refresh: the ack carries no pending approvals,
  // then the replay re-delivers the answered request and its resolution.
  dispatch({
    kind: 'chat_subscribed',
    sessionId: 'viewed-session',
    isProcessing: true,
    pendingPermissions: [],
  } as unknown as ServerEvent);
  dispatch(requestEvent('req-answered', 1));
  dispatch(resolvedEvent('req-answered', 2));

  assert.deepEqual(getPending(), []);
});

test('an unanswered request stays pending through a resolution for another id', () => {
  const { dispatch, getPending } = renderHandlers();

  dispatch(requestEvent('req-open', 1));
  dispatch(resolvedEvent('req-other', 2));

  const pending = getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, 'req-open');
});

for (const provider of ['opencode', 'codex'] as const) {
  test(`${provider} subscription restores pending approvals and waiting phase on the phone`, () => {
    const { dispatch, getPending, processing } = renderHandlers(provider);
    dispatch({ kind: 'chat_subscribed', provider, sessionId: 'viewed-session', isProcessing: true,
      canInterrupt: provider === 'codex', statusText: '等待审批',
      pendingPermissions: [{ requestId: 'restored-approval', toolName: 'Bash' }],
    } as unknown as ServerEvent);
    assert.equal(getPending()[0].requestId, 'restored-approval');
    assert.deepEqual(processing, [{ sessionId: 'viewed-session', canInterrupt: provider === 'codex', statusText: '等待审批' }]);
    dispatch({ ...resolvedEvent('restored-approval', 1), provider } as ServerEvent);
    assert.deepEqual(getPending(), []);
  });
}

test('an approval from another provider cannot enter or clear the viewed conversation', () => {
  const { dispatch, getPending } = renderHandlers('codex');
  dispatch({ ...requestEvent('codex-open', 1), provider: 'codex' } as ServerEvent);
  dispatch({ ...requestEvent('opencode-open', 2), provider: 'opencode' } as ServerEvent);
  dispatch({ ...resolvedEvent('codex-open', 3), provider: 'opencode' } as ServerEvent);
  assert.deepEqual(getPending().map((request) => request.requestId), ['codex-open']);
});
