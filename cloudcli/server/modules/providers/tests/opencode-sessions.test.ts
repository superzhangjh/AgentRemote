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
  /** Query strings of every v2 message request, in order. */
  messageQueries: string[];
  close(): Promise<void>;
};

/** Opaque pagination cursor for the stub's v2 message endpoint. */
function encodeMessageCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index }), 'utf8').toString('base64');
}

/** Reads back a stub cursor, defaulting to the first page. */
function decodeMessageCursor(value: string | null): number {
  if (!value) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { index?: unknown };
    return typeof parsed.index === 'number' && Number.isInteger(parsed.index) && parsed.index >= 0
      ? parsed.index
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Minimal stand-in for the OpenCode 2.0 HTTP server (`/api/*`).
 *
 * `sessions` and `messages` are read on every request so a test can mutate them
 * between syncs to model a title the server rewrites after the first turn. The
 * message endpoint pages like the real one (newest-first unless the caller asks
 * for `order=asc`), so history tests exercise the cursor walk.
 */
async function startServerStub(handlers: {
  sessions?: (directory?: string) => unknown[];
  messages?: (sessionId: string) => unknown[];
  /** Rows served by the 1.18 compatibility route, for the v2-empty fallback. */
  legacyMessages?: (sessionId: string) => unknown[];
  /** Page size the stub serves regardless of the requested limit. */
  messagePageSize?: number;
  /** Makes every message read answer 503, modelling a server busy with a turn. */
  failMessages?: boolean;
}): Promise<StubServer> {
  const connections = new Set<import('node:net').Socket>();
  const messageQueries: string[] = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const sendJson = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'GET' && url.pathname === '/api/session') {
      const limit = Number(url.searchParams.get('limit'));
      const directory = url.searchParams.get('directory') ?? undefined;
      const sessions = handlers.sessions?.(directory) ?? [];
      sendJson(200, {
        data: Number.isFinite(limit) && limit > 0 ? sessions.slice(0, limit) : sessions,
      });
      return;
    }

    const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (request.method === 'GET' && messagesMatch) {
      if (handlers.failMessages) {
        sendJson(503, { message: 'Server is busy completing a turn' });
        return;
      }
      messageQueries.push(url.search);
      const all = handlers.messages?.(decodeURIComponent(messagesMatch[1])) ?? [];
      const pageSize = handlers.messagePageSize ?? 200;
      const start = decodeMessageCursor(url.searchParams.get('cursor'));
      const nextIndex = start + pageSize;
      sendJson(200, {
        data: all.slice(start, nextIndex),
        cursor: {
          previous: start > 0 ? encodeMessageCursor(Math.max(0, start - pageSize)) : null,
          next: nextIndex < all.length ? encodeMessageCursor(nextIndex) : null,
        },
      });
      return;
    }

    const legacyMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (request.method === 'GET' && legacyMatch) {
      sendJson(200, handlers.legacyMessages?.(decodeURIComponent(legacyMatch[1])) ?? []);
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
    messageQueries,
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

/** One v2 `SessionV2Info` for the session list endpoint. */
function buildSessionInfo(input: {
  id: string;
  directory: string;
  title: string;
  created?: number;
  updated?: number;
  parentID?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    projectID: 'project-1',
    ...(input.parentID ? { parentID: input.parentID } : {}),
    title: input.title,
    location: { directory: input.directory },
    time: { created: input.created ?? 1_700_000_000_000, updated: input.updated ?? 1_700_000_004_000 },
  };
}

/** The v2 `SessionMessage[]` the server returns from `session/{id}/message`. */
function buildHistoryRows(sessionId: string, options: { userText: string }): unknown[] {
  return [
    {
      id: 'message-user',
      type: 'user',
      sessionID: sessionId,
      time: { created: 1_700_000_001_000 },
      text: options.userText,
    },
    {
      id: 'message-assistant',
      type: 'assistant',
      sessionID: sessionId,
      time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
      tokens: { input: 10, output: 20, reasoning: 7, cache: { read: 3, write: 2 } },
      content: [
        {
          id: 'part-reasoning',
          type: 'reasoning',
          text: 'I will inspect the provider shape first.',
        },
        {
          id: 'part-assistant-text',
          type: 'text',
          text: 'The provider is wired.',
        },
        {
          id: 'part-tool',
          type: 'tool',
          name: 'bash',
          state: {
            status: 'completed',
            input: { command: 'npm test' },
            content: [{ type: 'text', text: 'ok' }],
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
      buildSessionInfo({
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
      }),
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
      assert.equal(indexed?.open_code_server_id, 'configured');
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
    // A subagent run records its own session with `parentID` pointing at the
    // conversation that spawned it. It must not surface as a sidebar entry.
    sessions: () => [
      buildSessionInfo({
        id: 'open-child-session',
        parentID: 'open-session-1',
        directory: workspacePath,
        title: 'Explore the codebase (@explore subagent)',
        created: 1_700_000_005_000,
        updated: 1_700_000_006_000,
      }),
      buildSessionInfo({
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
      }),
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

test('OpenCode session synchronizer imports an unseen session even when the scan cursor is newer', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-cursor-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      buildSessionInfo({
        id: 'session-missed-by-a-scan',
        directory: workspacePath,
        title: 'Session an unreachable server hid',
        created: 1_700_000_000_000,
        updated: 1_700_000_004_000,
      }),
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      // The cursor stands in for a scan that ran while the owning server was
      // unreachable and advanced past this session's update time. The session
      // is missing from the index, so it must still be imported.
      const imported = await synchronizer.synchronize(new Date(1_700_000_100_000));
      assert.equal(imported, 1);
      assert.equal(
        sessionsDb.getSessionById('session-missed-by-a-scan')?.custom_name,
        'Session an unreachable server hid',
      );

      // A later scan must not re-process the row it has already indexed.
      const refreshed = await synchronizer.synchronize(new Date(1_700_000_200_000));
      assert.equal(refreshed, 0);
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer skips a conversation tombstoned by a force delete', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-tombstone-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      buildSessionInfo({
        id: 'tombstoned-session',
        directory: workspacePath,
        title: 'Deleted conversation',
      }),
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      sessionsDb.markProviderSessionSuperseded({
        providerSessionId: 'tombstoned-session',
        provider: 'opencode',
        sessionId: 'tombstoned-session',
        jsonlPath: null,
      });

      const count = await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(count, 0);
      assert.equal(sessionsDb.getSessionById('tombstoned-session'), null);
    }));
  } finally {
    await stub.close();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer skips internal sessions that ran in the OS temp root', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-tmpdir-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    // The CLI runs liveness/permission probes as sessions under the system
    // temp root. Their directories are gone once the probe ends, so importing
    // them leaves dead projects the approval bridge answers 500 for.
    sessions: () => [
      buildSessionInfo({
        id: 'opencode-cli-live-probe',
        directory: path.join(os.tmpdir(), 'opencode-cli-live-probe'),
        title: 'New session - internal probe',
      }),
      buildSessionInfo({
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
      }),
    ],
  });

  try {
    await withServerEnv(stub.url, () => withIsolatedDatabase(async () => {
      const count = await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(count, 1);
      assert.equal(sessionsDb.getSessionById('opencode-cli-live-probe'), null);
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
      buildSessionInfo({
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
      }),
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
      buildSessionInfo({
        id: 'open-session-1',
        directory: workspacePath,
        title: 'OpenCode indexed title',
      }),
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

test('OpenCode history folds question answers and hides a dismissal abort', { concurrency: false }, async () => {
  const rows = [
    {
      id: 'message-question-answered',
      type: 'assistant',
      sessionID: 'open-session-question',
      time: { created: 1_700_000_001_000 },
      content: [
        {
          id: 'part-question',
          type: 'tool',
          name: 'question',
          state: {
            status: 'completed',
            input: {
              questions: [{ header: 'Next', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
            },
            content: [{ type: 'text', text: 'User has answered your questions: "Continue?"="Yes".' }],
            metadata: { answers: [['Yes']] },
          },
        },
      ],
    },
    {
      id: 'message-question-dismissed',
      type: 'assistant',
      sessionID: 'open-session-question',
      time: { created: 1_700_000_002_000 },
      error: { type: 'aborted', message: 'Step interrupted' },
      content: [
        {
          id: 'part-question-dismissed',
          type: 'tool',
          name: 'question',
          state: {
            status: 'error',
            input: { questions: [{ header: 'Next', question: 'Continue?', options: [] }] },
            error: { type: 'aborted', message: 'The user dismissed this question' },
          },
        },
      ],
    },
  ];
  const stub = await startServerStub({ messages: () => rows });

  try {
    const history = await withServerEnv(stub.url, () =>
      new OpenCodeSessionsProvider().fetchHistory('open-session-question'));

    // A deliberate dismissal must not surface as a red step-abort error.
    assert.equal(history.messages.some((message) => message.kind === 'error'), false);

    const answered = history.messages.find((message) => message.toolName === 'AskUserQuestion');
    assert.deepEqual((answered?.toolInput as any)?.answers, { 'Continue?': 'Yes' });

    const dismissed = history.messages.filter((message) => message.kind === 'tool_use').at(-1);
    assert.equal(dismissed?.toolName, 'AskUserQuestion');
    assert.equal(dismissed?.toolResult?.isError, true);
  } finally {
    await stub.close();
  }
});

test('OpenCode history pages the v2 endpoint oldest-first across cursors', { concurrency: false }, async () => {
  // The default v2 page is the newest 50 messages in reverse order. History
  // must ask for `order=asc`, follow `cursor.next`, and keep the pages in that
  // order, or the phone shows a reversed, truncated conversation.
  const pagedRows = [
    { id: 'm1', type: 'user', sessionID: 'open-paged', time: { created: 1_700_000_001_000 }, text: 'first prompt' },
    {
      id: 'm2', type: 'assistant', sessionID: 'open-paged', time: { created: 1_700_000_002_000 },
      content: [{ id: 'p2', type: 'text', text: 'first reply' }],
    },
    { id: 'm3', type: 'user', sessionID: 'open-paged', time: { created: 1_700_000_003_000 }, text: 'second prompt' },
    {
      id: 'm4', type: 'assistant', sessionID: 'open-paged', time: { created: 1_700_000_004_000 },
      content: [{ id: 'p4', type: 'text', text: 'second reply' }],
    },
    { id: 'm5', type: 'user', sessionID: 'open-paged', time: { created: 1_700_000_005_000 }, text: 'third prompt' },
  ];
  const stub = await startServerStub({
    messages: () => pagedRows,
    messagePageSize: 2,
  });

  try {
    const history = await withServerEnv(stub.url, () =>
      new OpenCodeSessionsProvider().fetchHistory('open-paged'));

    assert.deepEqual(
      history.messages.map((message) => message.content),
      ['first prompt', 'first reply', 'second prompt', 'second reply', 'third prompt'],
    );
    assert.equal(history.total, 5);
    assert.equal(history.hasMore, false);
    // 5 rows over pages of 2 means three requests; the first fixes the order,
    // the rest only carry the cursor (the server rejects combining the two).
    assert.equal(stub.messageQueries.length, 3);
    assert.match(stub.messageQueries[0] ?? '', /order=asc/);
    assert.match(stub.messageQueries[1] ?? '', /cursor=/);
    assert.doesNotMatch(stub.messageQueries[1] ?? '', /order=/);
  } finally {
    await stub.close();
  }
});

test('OpenCode history falls back to the 1.18 route when the v2 page is empty', { concurrency: false }, async () => {
  // A 1.18 server answers its own legacy sessions with an empty v2 page
  // instead of a not-found error; only the compatibility route can read them.
  const stub = await startServerStub({
    messages: () => [],
    legacyMessages: (sessionId) => [
      {
        info: { id: `${sessionId}-user`, role: 'user', time: { created: 1_700_000_001_000 } },
        parts: [{ id: 'legacy-user-part', type: 'text', text: 'legacy prompt' }],
      },
      {
        info: { id: `${sessionId}-assistant`, role: 'assistant', time: { created: 1_700_000_002_000 } },
        parts: [{ id: 'legacy-assistant-part', type: 'text', text: 'legacy reply' }],
      },
    ],
  });

  try {
    const history = await withServerEnv(stub.url, () =>
      new OpenCodeSessionsProvider().fetchHistory('legacy-session'));

    assert.deepEqual(
      history.messages.map((message) => message.content),
      ['legacy prompt', 'legacy reply'],
    );
    assert.equal(history.total, 2);
  } finally {
    await stub.close();
  }
});

test('OpenCode history surfaces a retryable failure instead of an empty transcript', { concurrency: false }, async () => {
  // A provider server busy finishing a turn used to look identical to a
  // genuinely empty transcript: the phone showed "no history" and never
  // retried. A transient failure must fail loudly instead.
  const stub = await startServerStub({ failMessages: true });

  try {
    await withServerEnv(stub.url, async () => {
      await assert.rejects(
        () => new OpenCodeSessionsProvider().fetchHistory('ses_busy'),
        /temporarily unavailable/,
      );
    });
  } finally {
    await stub.close();
  }
});

test('OpenCode synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const stub = await startServerStub({
    sessions: () => [
      buildSessionInfo({
        id: 'oc-app-1',
        directory: workspacePath,
        title: 'OpenCode generated title',
        updated: 1_700_000_001_000,
      }),
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
      buildSessionInfo({ id: 'oc-placeholder-1', directory: workspacePath, title, updated }),
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
      buildSessionInfo({
        id: 'oc-indexed-1',
        directory: workspacePath,
        title: 'OpenCode generated title',
        updated: 1_700_000_001_000,
      }),
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
