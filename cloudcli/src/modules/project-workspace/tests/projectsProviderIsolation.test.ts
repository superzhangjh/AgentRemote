import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import { readCachedProjects, writeCachedProjects } from '@/modules/project-workspace/utils/projectsLocalCache';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider, Project } from '@/shared/types';

const projectsResponse = vi.fn();
const sessionDetailsResponse = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    projects: (provider: string) => projectsResponse(provider),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
  },
}));

const projectFor = (provider: LLMProvider): Project => ({
  projectId: `${provider}-project`,
  path: '/repo',
  fullPath: '/repo',
  displayName: provider,
  isStarred: false,
  sessions: [{ id: `${provider}-session`, __provider: provider }],
  sessionMeta: { hasMore: false, total: 1 },
});

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  sessionDetailsResponse.mockReset();
});

test('an unresolved deep link cannot retain or rebind the previous conversation', async () => {
  writeSelectedProvider('codex');
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [projectFor('codex')] });
  let resolveDetails: (response: unknown) => void = () => {};
  sessionDetailsResponse.mockImplementation(() => new Promise((resolve) => { resolveDetails = resolve; }));
  const subscribe = () => () => {};
  const navigate = vi.fn();
  const view = renderHook(({ sessionId }) => useProjectsState({
    sessionId,
    navigate: navigate as never,
    subscribe,
    isMobile: true,
    isSessionProcessing: () => false,
  }), { initialProps: { sessionId: 'codex-session' } });
  await waitFor(() => assert.equal(view.result.current.selectedSession?.id, 'codex-session'));

  view.rerender({ sessionId: 'missing-session' });
  await waitFor(() => assert.equal(view.result.current.selectedSession, null));
  assert.equal(view.result.current.selectedProject, null);
  await act(async () => resolveDetails({ ok: false }));
  assert.equal(view.result.current.selectedSession, null);
  assert.equal(view.result.current.selectedProject, null);
  view.unmount();
});

test('switching providers preserves the new cache even when the old response arrives late', async () => {
  writeSelectedProvider('codex');
  writeCachedProjects('codex', [projectFor('codex')]);
  writeCachedProjects('opencode', [projectFor('opencode')]);
  const resolveRequests = new Map<string, (response: unknown) => void>();
  projectsResponse.mockImplementation((provider: string) => new Promise((resolve) => {
    resolveRequests.set(provider, resolve);
  }));
  const subscribe = () => () => {};
  const view = renderHook(() => useProjectsState({
    navigate: vi.fn() as never,
    subscribe,
    isMobile: true,
    isSessionProcessing: () => false,
  }));
  await waitFor(() => assert.ok(resolveRequests.has('codex')));

  act(() => writeSelectedProvider('opencode'));
  await waitFor(() => assert.ok(resolveRequests.has('opencode')));
  assert.equal(view.result.current.projects[0]?.projectId, 'opencode-project');
  assert.equal(readCachedProjects('opencode')[0]?.projectId, 'opencode-project');

  await act(async () => {
    resolveRequests.get('codex')?.({ ok: true, json: async () => [projectFor('codex')] });
  });
  assert.equal(view.result.current.projects[0]?.projectId, 'opencode-project');
  assert.equal(readCachedProjects('opencode')[0]?.projectId, 'opencode-project');
  await act(async () => {
    resolveRequests.get('opencode')?.({ ok: true, json: async () => [projectFor('opencode')] });
  });
  view.unmount();
});
