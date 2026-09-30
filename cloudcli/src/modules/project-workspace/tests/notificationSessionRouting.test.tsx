import assert from 'node:assert/strict';

import type { ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';
import ProjectWorkspaceRoute from '@/modules/project-workspace/ProjectWorkspaceRoute';

const snapshots: Array<{ sessionId: string; provider: string }> = [];

vi.mock('@/modules/command-palette', () => ({
  PaletteOpsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  SessionProtectionProvider: ({ children }: { children: ReactNode }) => children,
  useSessionProtectionActions: () => ({
    isSessionProcessing: () => false,
    markSessionProcessing: vi.fn(),
    markSessionIdle: vi.fn(),
  }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ ws: null, sendMessage: vi.fn(), subscribe: () => () => {} }),
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({
  useDeviceSettings: () => ({ isMobile: true }),
}));
vi.mock('@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset', () => ({
  useVisualViewportKeyboardOffset: () => {},
}));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  ProjectsStateProvider: ({ sessionId, children }: { sessionId: string; children: ReactNode }) => {
    snapshots.push({ sessionId, provider: readSelectedProvider() });
    return children;
  },
}));
vi.mock('@/modules/project-workspace/ProjectWorkspaceShell', () => ({
  default: () => <div>Workspace</div>,
}));

beforeEach(() => {
  localStorage.clear();
  snapshots.length = 0;
});

test('every notification waits for its provider, including repeated taps for the same agent', async () => {
  writeSelectedProvider('codex');
  const router = createMemoryRouter([
    { path: '/session/:sessionId', element: <ProjectWorkspaceRoute /> },
  ], { initialEntries: ['/session/first?notificationProvider=opencode'] });
  const view = render(<RouterProvider router={router} />);

  await waitFor(() => assert.equal(router.state.location.search, '?provider=opencode'));
  assert.ok(snapshots.some((entry) => entry.sessionId === 'first'));
  assert.ok(snapshots.filter((entry) => entry.sessionId === 'first').every((entry) => entry.provider === 'opencode'));

  await act(async () => {
    writeSelectedProvider('codex');
    await router.navigate('/session/codex-chat');
  });
  snapshots.length = 0;
  await act(async () => {
    await router.navigate('/session/second?notificationProvider=opencode');
  });

  await waitFor(() => assert.equal(router.state.location.search, '?provider=opencode'));
  assert.ok(snapshots.some((entry) => entry.sessionId === 'second'));
  assert.ok(snapshots.filter((entry) => entry.sessionId === 'second').every((entry) => entry.provider === 'opencode'));
  view.unmount();
});
