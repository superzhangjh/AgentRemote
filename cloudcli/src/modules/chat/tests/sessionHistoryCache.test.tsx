import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import type { LLMProvider, NormalizedMessage, Project, ProjectSession } from '@/shared/types';

const { histories, readHistory, writeHistory, sessionMessages } = vi.hoisted(() => {
  const histories = new Map<string, unknown>();
  return {
    histories,
    readHistory: vi.fn(async (key: string) => histories.get(key) ?? null),
    writeHistory: vi.fn(async (value: { cacheKey: string }) => { histories.set(value.cacheKey, value); }),
    sessionMessages: vi.fn(),
  };
});

vi.mock('@/modules/chat/utils/sessionHistoryPersistence', () => ({
  readSessionHistory: readHistory,
  writeSessionHistory: writeHistory,
}));

vi.mock('@/shared/api', () => ({
  api: { providers: {
    sessionMessages,
    sessionTokenUsage: async () => ({ ok: false }),
  } },
}));

const key = (account = 'account-a', provider: LLMProvider = 'claude', sessionId = 'session-a') =>
  JSON.stringify([window.location.origin, account, provider, sessionId]);

const row = (index: number, sessionId = 'session-a', provider: LLMProvider = 'claude'): NormalizedMessage => ({
  id: `row-${index}`, sessionId, provider, kind: 'text', role: index % 2 ? 'assistant' : 'user',
  content: `message ${index}`, timestamp: new Date(index * 1000).toISOString(),
});

const response = (messages: NormalizedMessage[], hasMore = false, total = messages.length) => ({
  ok: true, json: async () => ({ data: { messages, total, hasMore } }),
});

function seed(messages: NormalizedMessage[], options: { hasMore?: boolean; fetchedAt?: number; account?: string } = {}) {
  histories.set(key(options.account), {
    cacheKey: key(options.account), sessionId: 'session-a', messages, realtimeMessages: [],
    hasMore: options.hasMore ?? false, total: messages.length, fetchedAt: options.fetchedAt ?? Date.now(),
  });
}

beforeEach(() => {
  histories.clear();
  readHistory.mockClear();
  writeHistory.mockClear();
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue(response([]));
});

describe('persisted session store', () => {
  it('restores all server rows after remount without requesting history', async () => {
    const first = renderHook(() => useSessionStore('account-a'));
    sessionMessages.mockResolvedValue(response([row(0), row(1)]));
    await act(async () => { await first.result.current.fetchFromServer('session-a', { limit: null }); });
    first.unmount();

    const second = renderHook(() => useSessionStore('account-a'));
    await act(async () => { await second.result.current.hydrateFromCache('session-a', 'claude'); });
    expect(second.result.current.getMessages('session-a')).toEqual([row(0), row(1)]);
    expect(sessionMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps background tool rows and finalized text alongside the existing disk history', async () => {
    seed([row(0), row(1)]);
    const first = renderHook(() => useSessionStore('account-a'));
    act(() => {
      first.result.current.appendRealtime('session-a', {
        ...row(2), kind: 'tool_use', toolId: 'tool-1', toolName: 'Read',
      });
      first.result.current.updateStreaming('session-a', 'partial', 'claude');
      first.result.current.updateStreaming('session-a', 'final answer', 'claude');
    });
    expect(writeHistory).not.toHaveBeenCalled();
    await act(async () => { first.result.current.finalizeStreaming('session-a'); });
    first.unmount();

    const second = renderHook(() => useSessionStore('account-a'));
    await act(async () => { await second.result.current.hydrateFromCache('session-a', 'claude'); });
    expect(second.result.current.getMessages('session-a').map((message) => message.content))
      .toEqual(['message 0', 'message 1', 'message 2', 'final answer']);
    expect(second.result.current.getMessages('session-a').some((message) => message.kind === 'stream_delta')).toBe(false);
    expect(writeHistory).toHaveBeenCalledTimes(1);
  });

  it('isolates providers and accounts and rejects misrouted realtime rows', async () => {
    seed([row(0)]);
    const view = renderHook(({ account }) => useSessionStore(account), { initialProps: { account: 'account-a' } });
    await act(async () => { await view.result.current.hydrateFromCache('session-a', 'codex'); });
    expect(view.result.current.getMessages('session-a')).toEqual([]);
    act(() => {
      view.result.current.appendRealtime('session-a', row(1));
      view.result.current.appendRealtime('session-a', row(2, 'session-b', 'codex'));
    });
    expect(view.result.current.getMessages('session-a')).toEqual([]);
    await act(async () => { await view.result.current.hydrateFromCache('session-a', 'claude'); });
    expect(view.result.current.getMessages('session-a')).toEqual([row(0)]);

    view.rerender({ account: 'account-b' });
    await act(async () => { await view.result.current.hydrateFromCache('session-a', 'claude'); });
    expect(view.result.current.getMessages('session-a')).toEqual([]);
    expect(readHistory).toHaveBeenCalledWith(key('account-b'));
  });

  it('writes a late HTTP response only to the account that started the request', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    sessionMessages.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = renderHook(({ account }) => useSessionStore(account), { initialProps: { account: 'account-a' } });
    let request!: Promise<unknown>;
    await act(async () => { request = view.result.current.fetchFromServer('session-a'); });
    view.rerender({ account: 'account-b' });
    await act(async () => { resolve(response([row(0)])); await request; });
    expect(view.result.current.getMessages('session-a')).toEqual([]);
    expect(histories.has(key('account-a'))).toBe(true);
    expect(histories.has(key('account-b'))).toBe(false);
  });

  it('retains cached history when an endpoint returns another session', async () => {
    seed([row(0)]);
    const view = renderHook(() => useSessionStore('account-a'));
    await act(async () => { await view.result.current.hydrateFromCache('session-a', 'claude'); });
    sessionMessages.mockResolvedValue(response([row(1, 'session-b')]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { await view.result.current.fetchFromServer('session-a'); });
    expect(view.result.current.getMessages('session-a')).toEqual([row(0)]);
    expect(view.result.current.getSessionSlot('session-a')?.status).toBe('error');
    expect(writeHistory).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

const project = { projectId: 'project-a', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false } as Project;
const session = { id: 'session-a', provider: 'claude' } as ProjectSession;
const resetStreamingState = vi.fn();

function renderSession() {
  return renderHook(({ isActive, selectedSession }) => {
    const store = useSessionStore('account-a');
    return useChatSessionState({
      isActive, selectedSession, selectedProject: project, sessionStore: store, ws: null,
      sendMessage: vi.fn(), resetStreamingState, statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
    });
  }, { initialProps: { isActive: true, selectedSession: session } });
}

describe('automatic session history loading', () => {
  it('loads the complete transcript on the first visit and reuses it on return', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => row(index));
    sessionMessages.mockImplementation(async (sessionId: string) => response(sessionId === 'session-a' ? messages : []));
    const view = renderSession();
    await act(async () => {});
    expect(view.result.current.chatMessages).toHaveLength(250);
    expect(view.result.current.visibleMessages).toHaveLength(100);
    expect(sessionMessages).toHaveBeenCalledWith('session-a', { limit: null, offset: 0 }, expect.anything());
    await act(async () => { view.rerender({ isActive: true, selectedSession: { ...session, id: 'session-b' } }); });
    await act(async () => { view.rerender({ isActive: true, selectedSession: session }); });
    expect(sessionMessages.mock.calls.filter(([sessionId]) => sessionId === 'session-a')).toHaveLength(1);
    expect(view.result.current.chatMessages).toHaveLength(250);
  });

  it('syncs only the latest page when a complete disk cache is stale', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => row(index));
    seed(messages, { fetchedAt: Date.now() - 60_000 });
    sessionMessages.mockResolvedValue(response(messages.slice(-20), true, messages.length));
    const view = renderSession();
    await act(async () => {});
    expect(view.result.current.chatMessages).toHaveLength(250);
    expect(sessionMessages).toHaveBeenCalledTimes(1);
    expect(sessionMessages).toHaveBeenCalledWith('session-a', { limit: 20, offset: 0 }, expect.anything());
  });

  it('automatically finishes a partial disk cache without a click', async () => {
    const messages = Array.from({ length: 120 }, (_, index) => row(index));
    seed(messages.slice(-20), { hasMore: true });
    sessionMessages.mockResolvedValue(response(messages));
    const view = renderSession();
    await act(async () => {});
    expect(view.result.current.chatMessages).toHaveLength(120);
    expect(view.result.current.hasMoreMessages).toBe(false);
    expect(view.result.current.isLoadingSessionMessages).toBe(false);
    expect(sessionMessages).toHaveBeenCalledWith('session-a', { limit: null, offset: 0 }, expect.anything());
  });

  it('keeps late history from the previous session out of the current view', async () => {
    const pending = new Map<string, (value: ReturnType<typeof response>) => void>();
    sessionMessages.mockImplementation((sessionId: string) => new Promise((resolve) => { pending.set(sessionId, resolve); }));
    const view = renderSession();
    await act(async () => {});
    await act(async () => { view.rerender({ isActive: true, selectedSession: { ...session, id: 'session-b' } }); });
    await act(async () => { pending.get('session-b')!(response([row(5, 'session-b')])); });
    await act(async () => { pending.get('session-a')!(response([row(0), row(1)])); });
    expect(view.result.current.chatMessages.map((message) => message.content)).toEqual(['message 5']);
    expect(view.result.current.totalMessages).toBe(1);
    await act(async () => { view.rerender({ isActive: true, selectedSession: session }); });
    expect(view.result.current.chatMessages.map((message) => message.content)).toEqual(['message 0', 'message 1']);
    expect(sessionMessages).toHaveBeenCalledTimes(2);
  });
});
