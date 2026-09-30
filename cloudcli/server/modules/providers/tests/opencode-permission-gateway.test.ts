import assert from 'node:assert/strict';
import test from 'node:test';

import { openCodePermissionGateway } from '@/modules/opencode-bridge/index.js';
import {
  installOpenCodePermissionGateway,
  opencodeRuntime,
} from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type { ProviderPermissionDecision } from '@/shared/types.js';

test('opencode runtime delegates pending approvals to the installed gateway', () => {
  const resolved: Array<{ requestId: string; decision: ProviderPermissionDecision }> = [];
  const pending = [{ requestId: 'perm-1', toolName: 'bash', sessionId: 'ses-1' }];

  installOpenCodePermissionGateway({
    listPending: (appSessionId: string) => (appSessionId === 'ses-1' ? pending : []),
    resolve: (requestId: string, decision: ProviderPermissionDecision) => {
      resolved.push({ requestId, decision });
    },
  });

  assert.deepEqual(opencodeRuntime.permissions.listPending('ses-1'), pending);
  assert.deepEqual(opencodeRuntime.permissions.listPending('other-session'), []);

  opencodeRuntime.permissions.resolve('perm-1', { allow: true, rememberEntry: 'bash' });
  assert.deepEqual(resolved, [{ requestId: 'perm-1', decision: { allow: true, rememberEntry: 'bash' } }]);
});

test('opencode runtime reports nothing pending when no gateway is installed', () => {
  installOpenCodePermissionGateway(null);

  assert.deepEqual(opencodeRuntime.permissions.listPending('ses-1'), []);
  // Must not throw when nothing is wired yet.
  opencodeRuntime.permissions.resolve('perm-1', { allow: false });
});

test('bridge permission gateway is empty until the server reports a prompt', () => {
  assert.deepEqual(openCodePermissionGateway.listPending('ses-1'), []);
  // No client is connected in a unit test, so an unknown decision is a no-op.
  openCodePermissionGateway.resolve('unknown-permission', { allow: true });
});
