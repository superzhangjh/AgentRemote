import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';

/**
 * The sidebar encodes session state in one leading dot, one colour per meaning:
 * blue while a run waits on the user, amber while it works, green when it has
 * finished with something unread. These assertions are the contract; the
 * colours had already drifted once.
 */
const PROJECT = {
  projectId: 'project-1',
  displayName: 'Project',
  fullPath: '/tmp/project',
  sessions: [],
} as unknown as Project;

const SESSION = {
  id: 'session-1',
  summary: 'A session',
  lastActivity: '2026-08-21T10:00:00.000Z',
  __provider: 'claude',
} as unknown as SessionWithProvider;

const t = ((key: string) => key) as never;
const noop = () => {};

const renderRow = (state: { isProcessing?: boolean; needsAttention?: boolean; isAwaitingInput?: boolean }) => {
  const { container } = render(
    React.createElement(SidebarSessionItem, {
      project: PROJECT,
      session: SESSION,
      selectedSession: null,
      isProcessing: state.isProcessing ?? false,
      needsAttention: state.needsAttention ?? false,
      isAwaitingInput: state.isAwaitingInput ?? false,
      currentTime: new Date('2026-08-21T10:00:00.000Z'),
      isEditing: false,
      renameDraft: '',
      onRenameDraftChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onDeleteSession: noop,
      t,
    }),
  );

  return container.querySelector('[role="status"]')?.className ?? null;
};

test('a run waiting on the user shows the blue dot', () => {
  assert.match(renderRow({ isAwaitingInput: true, isProcessing: true }) ?? '', /bg-blue-500/);
});

test('a working run shows the amber dot', () => {
  assert.match(renderRow({ isProcessing: true }) ?? '', /bg-amber-500/);
});

test('a finished unread run shows the green dot', () => {
  assert.match(renderRow({ needsAttention: true }) ?? '', /bg-emerald-500/);
});

test('an idle, read session shows no dot', () => {
  assert.equal(renderRow({}), null);
});
