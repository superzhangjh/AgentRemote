import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The batch delete dialog is the sidebar's only multi-select flow. These tests
 * pin what the project options entry promises: the list loads for the project
 * and provider being viewed, a running session cannot be selected, and the
 * confirm callback receives the selection with the archive/permanent mode.
 */

const projectSessions = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projectSessions: (...args: unknown[]) => projectSessions(...args),
  },
}));

const { default: BatchDeleteSessionsDialog } = await import('@/modules/sidebar/modals/BatchDeleteSessionsDialog');

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
}

const PROJECT = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-1',
} as Project;

const t = ((key: string) => key) as never;
const noop = () => {};

const session = (id: string) => ({
  id,
  provider: 'claude',
  summary: `Title ${id}`,
  messageCount: 1,
  lastActivity: '2026-08-21T09:00:00.000Z',
});

const pagePayload = (sessions: ReturnType<typeof session>[], hasMore = false) => ({
  ok: true,
  json: async () => ({ sessions, sessionMeta: { hasMore, total: sessions.length } }),
});

const renderDialog = (activeSessionIds: ReadonlySet<string> = new Set()) => {
  const onConfirm = vi.fn();
  render(
    <BatchDeleteSessionsDialog
      project={PROJECT}
      provider="claude"
      activeSessionIds={activeSessionIds}
      onConfirm={onConfirm}
      onCancel={noop}
      t={t}
    />,
  );

  return { onConfirm };
};

// DialogContent portals into document.body, so the rows are not under the
// render container.
const waitForCheckboxes = async (count: number) => {
  await waitFor(() => {
    assert.equal(document.querySelectorAll('input[type="checkbox"]').length, count);
  });
};

beforeEach(() => {
  projectSessions.mockReset();
});

test('the dialog loads the viewed project and provider and disables running rows', async () => {
  projectSessions.mockResolvedValue(pagePayload([session('s1'), session('s2')]));

  renderDialog(new Set(['s2']));
  await waitForCheckboxes(2);

  const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(checkboxes[0].disabled, false);
  assert.equal(checkboxes[1].disabled, true);
  assert.equal(projectSessions.mock.calls[0][0], 'project-1');
  assert.equal((projectSessions.mock.calls[0][1] as { provider: string }).provider, 'claude');
});

test('select all skips running sessions and archives the selection', async () => {
  projectSessions.mockResolvedValue(pagePayload([session('s1'), session('s2'), session('s3')]));

  const { onConfirm } = renderDialog(new Set(['s2']));
  await waitForCheckboxes(3);

  fireEvent.click(screen.getByText('batchDelete.selectAll'));
  fireEvent.click(screen.getByText('batchDelete.archiveSelected'));

  assert.deepEqual(onConfirm.mock.calls[0], [['s1', 's3'], false]);
});

test('permanent deletion sends the hard-delete flag for the checked rows only', async () => {
  projectSessions.mockResolvedValue(pagePayload([session('s1'), session('s2')]));

  const { onConfirm } = renderDialog();
  await waitForCheckboxes(2);

  fireEvent.click(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]);
  fireEvent.click(screen.getByText('batchDelete.deleteSelected'));

  assert.deepEqual(onConfirm.mock.calls[0], [['s1'], true]);
});

test('a load failure offers a retry that reloads the list', async () => {
  projectSessions.mockResolvedValueOnce({ ok: false, status: 500 });
  projectSessions.mockResolvedValueOnce(pagePayload([session('s1')]));

  renderDialog();

  await waitFor(() => {
    assert.ok(screen.getByText('batchDelete.loadFailed'));
  });

  fireEvent.click(screen.getByText('batchDelete.retry'));
  await waitForCheckboxes(1);
  assert.equal(projectSessions.mock.calls.length, 2);
});
