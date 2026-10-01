import assert from 'node:assert/strict';

import { test } from 'vitest';

import { applyRecentConversationRename } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { RecentConversationListItem } from '@/shared/types';

const conversation = (
  sessionId: string,
  overrides: Partial<RecentConversationListItem> = {},
): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'project one',
  sessionTitle: `title of ${sessionId}`,
  lastActivity: '2026-08-21T09:30:00.000Z',
  ...overrides,
});

test('a rename patches only the matching row title', () => {
  const before = [conversation('s1'), conversation('s2')];
  const after = applyRecentConversationRename(before, {
    sessionId: 's2',
    provider: 'claude',
    summary: 'Renamed from the phone',
  });

  assert.notEqual(after, before);
  assert.equal(after[0], before[0]);
  assert.equal(after[1].sessionTitle, 'Renamed from the phone');
  assert.equal(after[1].sessionId, 's2');
});

test('a rename for another provider is ignored', () => {
  const before = [conversation('s1')];
  const after = applyRecentConversationRename(before, {
    sessionId: 's1',
    provider: 'codex',
    summary: 'Different provider',
  });

  assert.equal(after, before);
  assert.equal(after[0].sessionTitle, 'title of s1');
});

test('an unchanged or unmatched title returns the same array reference', () => {
  const before = [conversation('s1')];

  assert.equal(
    applyRecentConversationRename(before, { sessionId: 's1', provider: 'claude', summary: 'title of s1' }),
    before,
  );
  assert.equal(
    applyRecentConversationRename(before, { sessionId: 'missing', provider: 'claude', summary: 'nope' }),
    before,
  );
});
