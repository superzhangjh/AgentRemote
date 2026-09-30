import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearExternalSessionActivity,
  isExternalSessionBusy,
  listExternalBusySessions,
  setExternalSessionActivity,
} from '@/modules/websocket/index.js';

test('external session activity tracks the owning provider while busy', { concurrency: false }, () => {
  clearExternalSessionActivity();

  setExternalSessionActivity('ses-open-1', 'opencode', true, '等待审批');
  assert.equal(isExternalSessionBusy('ses-open-1'), true);
  assert.deepEqual(listExternalBusySessions(), [
    { sessionId: 'ses-open-1', provider: 'opencode', statusText: '等待审批' },
  ]);

  setExternalSessionActivity('ses-open-1', 'opencode', false);
  assert.equal(isExternalSessionBusy('ses-open-1'), false);
  assert.deepEqual(listExternalBusySessions(), []);

  clearExternalSessionActivity();
});

test('external session activity ignores empty session ids', { concurrency: false }, () => {
  clearExternalSessionActivity();

  setExternalSessionActivity('', 'opencode', true);
  assert.deepEqual(listExternalBusySessions(), []);
  assert.equal(isExternalSessionBusy(''), false);

  clearExternalSessionActivity();
});
