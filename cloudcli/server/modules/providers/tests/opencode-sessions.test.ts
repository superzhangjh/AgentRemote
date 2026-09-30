import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type StubServer = {
  url: string;
  close(): Promise<void>;
};

/**
 * Minimal stand-in for the OpenCode HTTP server.
 *
 * `sessions` and `messages` are read on every request so a test can mutate them
 * between syncs to model a title the server rewrites after the first turn.
 */
async function startServerStub(handlers: {
  sessions?: () => unknown[];
  messages?: (sessionId: string) => unknown[];
}): Promise<StubServer> {
  const connections = new Set<import('node:net').Socket>();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const sendJson = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'GET' && url.pathname === '/session') {
      const limit = Number(url.searchParams.get('limit'));
      const sessions = handlers.sessions?.() ?? [];
      sendJson(200, Number.isFinite(limit) && limit > 0 ? sessions.slice(0, limit) : sessions);
      return;
    }

    const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (request.method === 'GET' && messagesMatch) {
      sendJson(200, handlers.messages?.(decodeURIComponent(messagesMatch[1])) ?? []);
      return;
    }

    sendJson(404, {});
  });

  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of connections) {
        socket.destroy();
      }
      server.close(() => resolve());
    }),
  };
}

async function withServerEnv<T>(url: string, body: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.OPENCODE_SERVER_URL;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_URL = url;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  try {
    return await body();
  } finally {
    if (previousUrl === undefined) delete process.env.OPENCODE_SERVER_URL;
    else process.env.OPENCODE_SERVER_URL = previousUrl;
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
  }
}

/** The `{ info, parts }` rows the server returns from `session/{id}/message`. */
function buildHistoryRows(sessionId: string, options: { userText: string }): unknown[] {
  return [
    {
      info: {
        id: 'message-user',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1_700_000_001_000 },
        agent: 'test',
        model: { providerID: 'anthropic', modelID: 'claude' },
      },
      parts: [
        {
          id: 'part-user-text',
          sessionID: sessionId,
          messageID: 'message-user',
          type: 'text',
          text: JSON.stringify(options.userText),
        },
      ],
    },
    {
      info: {
        id: 'message-assistant',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
        parentID: 'message-user',
        modelID: 'anthropic/claude-sonnet-4-5',
        providerID: 'anthropic',
        mode: 'default',
        agent: 'test',
        path: { cwd: '.', root: '.' },
        cost: 0.01,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 7,
          cache: { read: 3, write: 2 },
        },
      },
      parts: [
        {
          id: 'part-reasoning',
          sessionID: sessionId,
          messageID: 'message-assistant',
          type: 'reasoning',
          text: 'I will inspect the provider shape first.',
          time: { start: 0, end: 1 },
        },
        {
          id: 'part-assistant-text',
          sessionID: sessionId,
          messageID: 'message-assistant',
          type: 'text',
          text: 'The provider is wired.',
        },
        {
          id: 'part-tool',
          sessionID: sessionId,
          messageID: 'message-assistant',
          type: 'tool',
          tool: 'bash',
          callID: 'tool-call-1',
          state: {
            status: 'completed',
            input: { command: 'npm test' },
            output: 'ok',
            title: 'bash',
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ];
}

test('OpenCode session synchronizer indexes server sessions without deletable transcript paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      {
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_004_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      const count = await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(count, 1);
      const indexed = sessionsDb.getSessionById('open-session-1');
      assert.equal(indexed?.provider, 'opencode');
      assert.equal(indexed?.project_path, workspacePath);
      assert.equal(indexed?.custom_name, 'OpenCode indexed title');
      assert.equal(indexed?.jsonl_path, null);
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer skips subagent child sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-child-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      // A subagent run records its own session with `parentID` pointing at the
      // conversation that spawned it. It must not surface as a sidebar entry.
      {
        id: 'open-child-session',
        parentID: 'open-session-1',
        directory: workspacePath,
        title: 'Explore the codebase (@explore subagent)',
        time: { created: 1_700_000_005_000, updated: 1_700_000_006_000 },
      },
      {
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_004_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      const count = await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(count, 1);
      assert.equal(sessionsDb.getSessionById('open-child-session'), null);
      assert.deepEqual(
        sessionsDb.getAllSessions().map((session) => session.session_id),
        ['open-session-1'],
      );
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      {
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_004_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-session-1', 'open-session-1');

      const sessionId = await new OpenCodeSessionSynchronizer().synchronizeFile('opencode.db');
      assert.equal(sessionId, 'app-session-1');
      assert.equal(sessionsDb.getAllSessions().length, 1);
      assert.equal(sessionsDb.getSessionById('app-session-1')?.provider_session_id, 'open-session-1');
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      {
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_004_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-session-race', 'opencode', workspacePath);

      const sessionId = await new OpenCodeSessionSynchronizer().synchronizeFile('opencode.db');
      assert.equal(sessionId, 'app-session-race');
      assert.equal(sessionsDb.getAllSessions().length, 1);
      assert.equal(sessionsDb.getSessionById('app-session-race')?.provider_session_id, 'open-session-1');
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider strips <images_input> from user turns and exposes attachments', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-images-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const taggedPrompt = appendImagesInputTag('Look at this screenshot.', [
    { path: 'C:/Users/x/.cloudcli/assets/shot.png' },
  ]);
  const stub = await startServerStub({
    messages: (sessionId) => buildHistoryRows(sessionId, { userText: taggedPrompt }),
  });

  try {
    const history = await withServerEnv(stub.url, () =>
      new OpenCodeSessionsProvider().fetchHistory('open-session-1'));
    const userMessage = history.messages.find((message) => message.kind === 'text' && message.role === 'user');

    assert.equal(userMessage?.content, 'Look at this screenshot.');
    assert.deepEqual(userMessage?.images, [{ path: 'C:/Users/x/.cloudcli/assets/shot.png' }]);
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider normalizes quoted live text and skips user echoes', () => {
  const provider = new OpenCodeSessionsProvider();
  const normalized = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    text: JSON.stringify('hello bro'),
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'stream_delta');
  assert.equal(normalized[0]?.content, 'hello bro');

  const userEcho = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    role: 'user',
    text: 'hello bro',
  }, null);

  assert.deepEqual(userEcho, []);
});

test('OpenCode sessions provider reads history and token usage from the server', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    messages: (sessionId) => buildHistoryRows(sessionId, { userText: 'Build the OpenCode integration.' }),
  });

  try {
    const provider = new OpenCodeSessionsProvider();
    const history = await withServerEnv(stub.url, () => provider.fetchHistory('open-session-1'));

    assert.equal(history.total, 4);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build the OpenCode integration.');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[2]?.content, 'The provider is wired.');
    assert.equal(history.messages[3]?.kind, 'tool_use');
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: {
        input: 13,
        output: 20,
      },
    });

    const paged = await withServerEnv(stub.url, () =>
      provider.fetchHistory('open-session-1', { limit: 2, offset: 0 }));
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.messages[0]?.content, 'The provider is wired.');
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      {
        id: 'oc-app-1',
        directory: workspacePath,
        title: 'OpenCode generated title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the checkout crash');
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer replaces the creation placeholder with the generated title', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-placeholder-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  let title = 'New session - 2026-09-29T04:02:30.001Z';
  let updated = 1_700_000_001_000;
  const stub = await startServerStub({
    sessions: () => [
      { id: 'oc-placeholder-1', directory: workspacePath, title, time: { created: 1_700_000_000_000, updated } },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(
        sessionsDb.getSessionById('oc-placeholder-1')?.custom_name,
        'New session - 2026-09-29T04:02:30.001Z',
      );

      // OpenCode rewrites the title once the first turn completes. The watcher
      // observes the newer time_updated and must adopt the generated title.
      title = '会话名与同步进度问题';
      updated = 1_700_000_002_000;

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(
        sessionsDb.getSessionById('oc-placeholder-1')?.custom_name,
        '会话名与同步进度问题',
      );
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      {
        id: 'oc-indexed-1',
        directory: workspacePath,
        title: 'OpenCode generated title',
        time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
      },
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('oc-indexed-1')?.custom_name, 'OpenCode generated title');
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
