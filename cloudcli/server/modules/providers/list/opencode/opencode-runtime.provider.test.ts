import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  isOpenCodeQuestionAllowed,
  opencodeRuntime,
  resolveOpenCodePermissionRuleset,
} from './opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId: string | null) => sessionId || null,
  resolveResumeModel: async (_sessionId: string | undefined, requestedModel?: string | null) =>
    requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw: unknown, sessionId: string | null) =>
    sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

function createWriter(messages: unknown[] = []) {
  const writer = {
    userId: null as string | number | null,
    sessionId: null as string | null,
    send(message: unknown) {
      messages.push(message);
    },
    setSessionId(sessionId: string) {
      writer.sessionId = sessionId;
    },
  };
  return writer;
}

type ServerStub = {
  url: string;
  requests: Array<{ method: string | undefined; path: string }>;
  pushEvent(event: unknown): void;
  close(): Promise<void>;
};

/**
 * Minimal stand-in for the OpenCode HTTP server, covering the v2 session
 * endpoints the runtime drives plus a hand-driven `/event` SSE stream.
 */
async function startServerStub(options: {
  createdSessionId?: string;
  existingSession?: Record<string, unknown> | null;
} = {}): Promise<ServerStub> {
  const createdSessionId = options.createdSessionId ?? 'ses_live';
  const requests: ServerStub['requests'] = [];
  const eventStreams = new Set<http.ServerResponse>();
  const connections = new Set<import('node:net').Socket>();

  const writeEvent = (response: http.ServerResponse, event: unknown): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname });

    if (request.method === 'GET' && url.pathname === '/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      eventStreams.add(response);
      response.on('close', () => eventStreams.delete(response));
      return;
    }

    let rawBody = '';
    request.on('data', (chunk) => { rawBody += chunk; });
    request.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
      const sendJson = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (request.method === 'POST' && url.pathname === '/session') {
        sendJson(200, { id: createdSessionId, directory: body.directory ?? '/tmp' });
        return;
      }
      if (request.method === 'GET' && /^\/session\/[^/]+$/.test(url.pathname)) {
        sendJson(200, options.existingSession ?? { id: createdSessionId, directory: '/tmp', permission: [] });
        return;
      }
      if (request.method === 'PATCH' && /^\/session\/[^/]+$/.test(url.pathname)) {
        sendJson(200, { id: createdSessionId, permission: body.permission ?? [] });
        return;
      }
      if (request.method === 'POST' && /\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && /\/session\/[^/]+\/abort$/.test(url.pathname)) {
        sendJson(200, true);
        return;
      }

      sendJson(404, {});
    });
  });

  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    pushEvent(event: unknown) {
      for (const stream of eventStreams) {
        writeEvent(stream, event);
      }
    },
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

function emitSuccessfulTurn(stub: ServerStub, sessionId = 'ses_live'): void {
  stub.pushEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      time: Date.now(),
      part: { id: 'part-text', sessionID: sessionId, messageID: 'msg-1', type: 'text', text: 'assistant response' },
    },
  });
  stub.pushEvent({
    type: 'message.updated',
    properties: {
      sessionID: sessionId,
      info: {
        id: 'msg-1',
        sessionID: sessionId,
        role: 'assistant',
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
      },
    },
  });
  stub.pushEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      time: Date.now(),
      part: { id: 'part-step', sessionID: sessionId, messageID: 'msg-1', type: 'step-finish' },
    },
  });
  stub.pushEvent({ type: 'session.idle', properties: { sessionID: sessionId } });
}

test('opencode runtime streams a new session through the server SDK', async () => {
  const stub = await startServerStub();
  const messages: Array<Record<string, unknown>> = [];
  const writer = createWriter(messages);

  try {
    await withServerEnv(stub.url, async () => {
      const runPromise = opencodeRuntime.run('Hi', { cwd: '/tmp' }, writer, runtimeContext);
      // Wait for the runtime to subscribe to /event before emitting the turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      emitSuccessfulTurn(stub);
      await runPromise;

      const sessionCreated = messages.find((message) => message.kind === 'session_created');
      const deltas = messages.filter((message) => message.kind === 'stream_delta');
      const streamEnd = messages.find((message) => message.kind === 'stream_end');
      const tokenStatus = messages.find(
        (message) => message.kind === 'status' && message.text === 'token_budget',
      );
      const complete = messages.find((message) => message.kind === 'complete');

      assert.equal(sessionCreated?.newSessionId, 'ses_live');
      assert.equal(writer.sessionId, 'ses_live');
      assert.equal(deltas.length, 1);
      assert.equal(deltas[0]?.content, 'assistant response');
      assert.ok(streamEnd);
      assert.deepEqual(tokenStatus?.tokenBudget, {
        used: 17,
        inputTokens: 12,
        outputTokens: 5,
        breakdown: { input: 12, output: 5 },
      });
      assert.equal(complete?.exitCode, 0);
      assert.equal(messages.some((message) => message.kind === 'error'), false);
      assert.ok(
        stub.requests.some((request) => request.method === 'POST' && request.path === '/session'),
        `expected a POST /session, saw ${JSON.stringify(stub.requests)}`,
      );
    });
  } finally {
    await stub.close();
  }
});

test('opencode runtime creates the session on the server so questions are allowed', async () => {
  const stub = await startServerStub({ createdSessionId: 'ses_stubbed' });
  const messages: Array<Record<string, unknown>> = [];
  const writer = createWriter(messages);

  try {
    await withServerEnv(stub.url, async () => {
      const runPromise = opencodeRuntime.run('Hi', { cwd: '/tmp' }, writer, runtimeContext);
      await new Promise((resolve) => setTimeout(resolve, 50));
      emitSuccessfulTurn(stub, 'ses_stubbed');
      await runPromise;

      const created = messages.find((message) => message.kind === 'session_created');
      assert.equal(created?.newSessionId, 'ses_stubbed');
      assert.equal(writer.sessionId, 'ses_stubbed');
      assert.equal(messages.find((message) => message.kind === 'complete')?.sessionId, 'ses_stubbed');
    });
  } finally {
    await stub.close();
  }
});

test('opencode runtime repairs a resumed session whose question permission is denied', async () => {
  const providerSessionId = 'ses_existing_provider';
  const stub = await startServerStub({
    createdSessionId: providerSessionId,
    existingSession: {
      id: providerSessionId,
      directory: '/tmp',
      permission: [{ permission: 'question', pattern: '*', action: 'deny' }],
    },
  });
  const messages: Array<Record<string, unknown>> = [];
  const writer = createWriter(messages);
  const resumeContext = {
    ...runtimeContext,
    resolveProviderSessionId: () => providerSessionId,
  };

  try {
    await withServerEnv(stub.url, async () => {
      const runPromise = opencodeRuntime.run('Hi', { cwd: '/tmp' }, writer, resumeContext);
      await new Promise((resolve) => setTimeout(resolve, 50));
      emitSuccessfulTurn(stub, providerSessionId);
      await runPromise;

      assert.ok(
        stub.requests.some(
          (request) => request.method === 'PATCH' && request.path === `/session/${providerSessionId}`,
        ),
        `expected a PATCH /session/{id}, saw ${JSON.stringify(stub.requests)}`,
      );
      // A resumed session never emits session_created.
      assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    });
  } finally {
    await stub.close();
  }
});

test('opencode runtime surfaces a server session error and fails the run', async () => {
  const stub = await startServerStub();
  const messages: Array<Record<string, unknown>> = [];
  const writer = createWriter(messages);

  try {
    await withServerEnv(stub.url, async () => {
      const runPromise = opencodeRuntime.run('Hi', { cwd: '/tmp' }, writer, runtimeContext);
      await new Promise((resolve) => setTimeout(resolve, 50));
      stub.pushEvent({
        type: 'session.error',
        properties: { sessionID: 'ses_live', error: { message: 'model unavailable' } },
      });
      await assert.rejects(runPromise, /model unavailable/);

      const complete = messages.find((message) => message.kind === 'complete');
      assert.equal(complete?.exitCode, 1);
    });
  } finally {
    await stub.close();
  }
});

test('opencode runtime abort reports false for an unknown session', () => {
  assert.equal(opencodeRuntime.abort('missing-session'), false);
});

test('resolveOpenCodePermissionRuleset maps UI permission modes onto session rulesets', () => {
  const bypass = resolveOpenCodePermissionRuleset('bypassPermissions');
  assert.ok(bypass?.some((rule) => rule.permission === 'edit' && rule.action === 'allow'));
  assert.ok(bypass?.some((rule) => rule.permission === 'bash' && rule.action === 'allow'));

  assert.deepEqual(resolveOpenCodePermissionRuleset('acceptEdits'), [
    { permission: 'edit', pattern: '*', action: 'allow' },
  ]);
  // default and plan leave the user's own config in charge.
  assert.equal(resolveOpenCodePermissionRuleset('plan'), undefined);
  assert.equal(resolveOpenCodePermissionRuleset('default'), undefined);
  assert.equal(resolveOpenCodePermissionRuleset(undefined), undefined);
});

test('isOpenCodeQuestionAllowed reads the last matching question rule', () => {
  assert.equal(isOpenCodeQuestionAllowed(undefined), true);
  assert.equal(isOpenCodeQuestionAllowed([]), true);
  assert.equal(
    isOpenCodeQuestionAllowed([{ permission: 'question', pattern: '*', action: 'deny' }]),
    false,
  );
  assert.equal(
    isOpenCodeQuestionAllowed([
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'allow' },
    ]),
    true,
  );
  assert.equal(
    isOpenCodeQuestionAllowed([
      { permission: 'question', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'deny' },
    ]),
    false,
  );
});
