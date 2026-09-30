import assert from 'node:assert/strict';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex app-server ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedInput: Parameters<typeof codexAppServer.runTurn>[0] | undefined;
      const messages: any[] = [];
      t.mock.method(codexAppServer, 'runTurn', async (input: Parameters<typeof codexAppServer.runTurn>[0]) => {
        capturedInput = input;
        input.onThread({ id: 'native-thread' });
        input.onNotification({
          method: 'turn/completed',
          params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } },
        });
      });

      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.ok(capturedInput);
      assert.equal(capturedInput.threadId, resumed ? 'native-thread' : null);
      assert.equal(capturedInput.model, 'test-model');
      assert.deepEqual(capturedInput.turnInput, [{ type: 'text', text: 'hey there', text_elements: [] }]);
      assert.equal(capturedInput.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedInput.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
      assert.equal(messages.some((message) => message.kind === 'session_created'), !resumed);
      assert.ok(!messages.some((message) => message.kind === 'error'));
    });
  }
}

test('Codex app-server approval requests resolve through the existing chat permission channel', async (t) => {
  let finishRun!: () => void;
  let resolveApproval!: (value: unknown) => void;
  const messages: any[] = [];
  const approval = new Promise<unknown>((resolve) => { resolveApproval = resolve; });
  t.mock.method(codexAppServer, 'runTurn', async (input: Parameters<typeof codexAppServer.runTurn>[0]) => {
    input.onThread({ id: 'approval-thread' });
    const result = input.onServerRequest({
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'approval-thread', command: 'pnpm test', cwd: '/workspace' },
    });
    finishRun = () => input.onNotification({
      method: 'turn/completed',
      params: { threadId: 'approval-thread', turn: { id: 'turn-1', status: 'completed' } },
    });
    const resultPromise = Promise.resolve(result);
    await approval;
    finishRun();
    await resultPromise;
  });

  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const run = codexRuntime.run('run tests', { sessionId: 'app-session' }, {
    isWebSocketWriter: true,
    send: (message) => messages.push(message),
  }, context);

  const waitForPrompt = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const prompt = messages.find((message) => message.kind === 'permission_request');
      if (prompt) return prompt;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Permission prompt was not emitted.');
  };

  const prompt = await waitForPrompt();
  assert.equal(prompt.toolName, 'Bash');
  assert.equal(prompt.input.command, 'pnpm test');
  codexRuntime.permissions?.resolve(prompt.requestId, { allow: true });
  resolveApproval(true);

  await run;
  assert.ok(messages.some((message) => message.kind === 'permission_resolved' && message.requestId === prompt.requestId));
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
});

test('Codex questions survive pending replay and phone answers use native question ids', async (t) => {
  const messages: any[] = [];
  let response: unknown;
  t.mock.method(codexAppServer, 'runTurn', async (input: Parameters<typeof codexAppServer.runTurn>[0]) => {
    input.onThread({ id: 'question-native-thread' });
    const result = input.onServerRequest({ id: 'server-question-id', method: 'item/tool/requestUserInput', params: {
      threadId: 'question-native-thread', questions: [
        { id: 'target', question: 'Which target?', header: 'Target', options: [{ label: 'Phone', description: '' }] },
        { id: 'notes', question: 'Any notes?', header: 'Notes', options: null },
      ],
    } });
    const pending = codexRuntime.permissions.listPending('app-question-session') as any[];
    assert.equal(pending.length, 1);
    assert.deepEqual(codexRuntime.permissions.listPending('question-native-thread'), []);
    assert.deepEqual(pending[0].input.questions[1].options, []);
    codexRuntime.permissions.resolve(pending[0].requestId, { allow: true, updatedInput: {
      answers: { 'Which target?': 'Phone', 'Any notes?': 'Keep commas, intact' },
    } });
    response = await result;
    assert.deepEqual(codexRuntime.permissions.listPending('app-question-session'), []);
  });
  await codexRuntime.run('ask me', { sessionId: 'app-question-session' }, {
    isWebSocketWriter: true, send: (message) => messages.push(message),
  }, {
    resolveProviderSessionId: () => 'question-native-thread',
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  });
  assert.deepEqual(response, { answers: {
    target: { answers: ['Phone'] }, notes: { answers: ['Keep commas, intact'] },
  } });
  assert.ok(messages.some((message) => message.kind === 'permission_resolved' && message.sessionId === 'app-question-session'));
});

test('Codex cancellation retracts a pending approval and releases its server request', async (t) => {
  const messages: any[] = [];
  let approval: Promise<unknown> | undefined;
  t.mock.method(codexAppServer, 'runTurn', async (input: Parameters<typeof codexAppServer.runTurn>[0]) => {
    input.onThread({ id: 'cancel-native-thread' });
    approval = input.onServerRequest({ id: 91, method: 'item/fileChange/requestApproval', params: {
      threadId: 'cancel-native-thread', grantRoot: '/workspace/file.ts',
    } });
    assert.equal(codexRuntime.permissions.listPending('app-cancel-session').length, 1);
    assert.equal(codexRuntime.abort('app-cancel-session'), true);
    assert.deepEqual(await approval, { decision: 'decline' });
  });
  await codexRuntime.run('edit a file', { sessionId: 'app-cancel-session' }, {
    isWebSocketWriter: true, send: (message) => messages.push(message),
  }, {
    resolveProviderSessionId: () => 'cancel-native-thread', resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  });
  assert.deepEqual(codexRuntime.permissions.listPending('app-cancel-session'), []);
  assert.ok(messages.some((message) => message.kind === 'permission_cancelled'));
  // The terminal `complete` (aborted: true) is emitted by the chat gateway's
  // abort handler (see handleChatAbort); the runtime must not send a second one.
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
});
