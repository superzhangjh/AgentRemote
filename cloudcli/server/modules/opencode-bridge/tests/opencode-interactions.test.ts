import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { openCodePermissionGateway, startOpenCodeBridge, stopOpenCodeBridge } from '@/modules/opencode-bridge/index.js';
import { handleOpenCodeEvent } from '@/modules/opencode-bridge/opencode-bridge.service.js';
import { connectedClients, listExternalBusySessions } from '@/modules/websocket/index.js';

const NATIVE_ID = 'shared-native-id';
const APP_ID = 'phone-opencode-session';
type Request = Record<string, unknown>;

async function waitUntil(check: () => boolean, attempts = 600): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The bridge did not deliver the expected interaction.');
}

test('bridge restores approvals over the v2 API, answers them and keeps failed replies retryable', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-interactions-'));
  // The bridge only reconciles approvals for directories that exist on disk,
  // so the session's project path has to be real.
  const workspaceDirectory = path.join(tempDirectory, 'workspace');
  await mkdir(workspaceDirectory, { recursive: true });
  const previousEnvironment = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
    OPENCODE_BRIDGE_DISABLED: process.env.OPENCODE_BRIDGE_DISABLED,
  };
  const permissions: Request[] = [{ id: 'restore-permission', sessionID: NATIVE_ID, permission: 'bash', metadata: { command: 'npm test' }, patterns: ['npm test'] }];
  const questions: Request[] = [];
  const forms: Request[] = [];
  const frames: Request[] = [];
  const posts: Array<{ path: string; directory: string | null; body: unknown }> = [];
  const deletes: string[] = [];
  const streams = new Set<ServerResponse>();
  let failReply = false;
  let connections = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/event') {
      connections++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'evt-1', type: 'server.connected', data: {} })}\n\n`);
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    const formListMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form$/);
    if (request.method === 'GET' && formListMatch) {
      const sessionId = decodeURIComponent(formListMatch[1]);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: forms.filter((form) => form.sessionID === sessionId) }));
      return;
    }
    // The desktop-server shape: 2.0 serves its web app on this route instead of
    // health JSON, which is what tells the bridge to use `decision` replies.
    if (url.pathname === '/global/health') {
      response.writeHead(404);
      response.end();
      return;
    }
    const directory = url.searchParams.get('location[directory]') ?? url.searchParams.get('directory');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'DELETE') {
      deletes.push(url.pathname);
      for (const list of [permissions, questions, forms]) {
        const index = list.findIndex((entry) => url.pathname.includes(String(entry.id)));
        if (index !== -1) list.splice(index, 1);
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      posts.push({ path: url.pathname, directory, body: JSON.parse(body || '{}') });
      if (failReply) {
        failReply = false;
        response.writeHead(503);
        response.end('{"message":"Try again"}');
        return;
      }
      // A real server drops an answered request from its pending list, so a
      // reconnect snapshot taken after the reply cannot resurrect the prompt.
      for (const list of [permissions, questions, forms]) {
        const index = list.findIndex((entry) => url.pathname.includes(String(entry.id)));
        if (index !== -1) list.splice(index, 1);
      }
      if (url.pathname.endsWith('/reply') && url.pathname.includes('/form/')) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.end('{"data":{}}');
      return;
    }
    const inProject = directory === workspaceDirectory;
    const data = url.pathname === '/api/session/active' ? { data: { [NATIVE_ID]: { type: 'running' } } }
      : url.pathname === '/api/permission/request' ? { data: inProject ? permissions : [] }
        : url.pathname === '/api/question/request' ? { data: inProject ? questions : [] } : { data: [] };
    response.end(JSON.stringify(data));
  });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    // A colliding native id in another provider must never receive the prompt.
    sessionsDb.createAppSession(NATIVE_ID, 'codex', '/workspace/codex');
    sessionsDb.assignProviderSessionId(NATIVE_ID, NATIVE_ID);
    sessionsDb.createAppSession(APP_ID, 'opencode', workspaceDirectory);
    sessionsDb.assignProviderSessionId(APP_ID, NATIVE_ID);
    connectedClients.add({ readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.OPENCODE_SERVER_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_BRIDGE_DISABLED;
    startOpenCodeBridge();

    await waitUntil(() => connections === 1 && openCodePermissionGateway.listPending(APP_ID).length === 1);
    assert.deepEqual(openCodePermissionGateway.listPending(NATIVE_ID), []);
    assert.equal(listExternalBusySessions().find((entry) => entry.sessionId === APP_ID)?.statusText, '等待审批');
    // Regression: the v2 active envelope must not leak its outer `data` key as
    // a session id. That pinned a phantom "OpenCode 正在处理" entry on the phone
    // that never matched a real session.
    assert.equal(listExternalBusySessions().some((entry) => entry.sessionId === 'data'), false);
    handleOpenCodeEvent({ type: 'session.status', properties: { sessionID: NATIVE_ID, status: { type: 'busy' } } });
    assert.equal(listExternalBusySessions().find((entry) => entry.sessionId === APP_ID)?.statusText, '等待审批');

    failReply = true;
    const promptsBeforeFailure = frames.filter((frame) => frame.kind === 'permission_request').length;
    openCodePermissionGateway.resolve('restore-permission', { allow: true });
    await waitUntil(() => frames.filter((frame) => frame.kind === 'permission_request').length > promptsBeforeFailure);
    assert.equal(openCodePermissionGateway.listPending(APP_ID).length, 1);
    openCodePermissionGateway.resolve('restore-permission', { allow: true, rememberEntry: 'npm test' });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/permission/restore-permission/reply`, directory: null,
      body: { decision: 'always' },
    });
    permissions.length = 0;

    // No permission event arrives while disconnected: recovery must list it.
    permissions.push({ id: 'v2-restored', sessionID: NATIVE_ID, action: 'read', resources: ['/tmp/log'] });
    for (const stream of streams) stream.end();
    await waitUntil(() => connections === 2 && openCodePermissionGateway.listPending(APP_ID).length === 1);
    openCodePermissionGateway.resolve('v2-restored', { allow: false, message: 'Denied on phone' });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/permission/v2-restored/reply`, directory: null,
      body: { decision: 'reject', message: 'Denied on phone' },
    });
    permissions.length = 0;

    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'permission.asked', properties: {
      id: 'asked-permission', sessionID: NATIVE_ID, permission: 'bash', patterns: ['rm -rf /tmp/x'],
    } });
    openCodePermissionGateway.resolve('asked-permission', { allow: true });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.equal(posts.at(-1)?.path, `/api/session/${NATIVE_ID}/permission/asked-permission/reply`);

    questions.push({ id: 'question-fallback', sessionID: NATIVE_ID, tool: { callID: 'tool-question' },
      questions: [{ question: 'Choose targets', header: 'Targets', multiple: true, options: [] }] });
    // The session id lives in `part`, not the event's top-level properties.
    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'message.part.updated', properties: {
      part: { sessionID: NATIVE_ID, type: 'tool', tool: 'question', callID: 'tool-question', state: { status: 'running' } },
    } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 1);
    assert.equal(listExternalBusySessions().find((entry) => entry.sessionId === APP_ID)?.statusText, '等待回答');
    openCodePermissionGateway.resolve('question-fallback', { allow: true, updatedInput: { answers: { 'Choose targets': 'Phone, Desktop' } } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/question/question-fallback/reply`, directory: null,
      body: { answers: [['Phone', 'Desktop']] },
    });
    questions.length = 0;

    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'question.v2.asked', properties: {
      id: 'v2-question', sessionID: NATIVE_ID,
      questions: [{ question: 'Continue?', header: 'Next', options: [] }],
    } });
    openCodePermissionGateway.resolve('v2-question', { allow: true, updatedInput: { answers: { 'Continue?': 'Yes' } } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/question/v2-question/reply`, directory: null, body: { answers: [['Yes']] },
    });
    assert.ok(frames.some((frame) => frame.kind === 'permission_resolved' && frame.requestId === 'v2-question'));

    // OpenCode 2.0+ desktop servers raise the `question` tool as a form. A live
    // `form.created` must ride the same panel, notify, and answer through the
    // form API using each field's key.
    const questionForm = {
      id: 'form-question', sessionID: NATIVE_ID, title: 'Questions',
      metadata: { kind: 'question', tool: { messageID: 'message-1', id: 'tool-call-1' } },
      fields: [
        { key: 'q0', title: 'Targets', description: 'Choose targets', type: 'multiselect',
          options: [{ value: 'Phone', label: 'Phone' }, { value: 'Desktop', label: 'Desktop' }], custom: true },
        { key: 'q1', title: 'Notes', description: 'Any notes?', type: 'string', options: [], custom: true },
      ],
    };
    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'form.created', data: { form: questionForm } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 1);
    assert.equal(listExternalBusySessions().find((entry) => entry.sessionId === APP_ID)?.statusText, '等待回答');
    assert.ok(frames.some((frame) => frame.kind === 'permission_request'
      && frame.requestId === 'form-question' && frame.toolName === 'AskUserQuestion'));
    openCodePermissionGateway.resolve('form-question', { allow: true, updatedInput: { answers: {
      'Choose targets': 'Phone, Desktop',
      'Any notes?': 'Ship it',
    } } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/form/form-question/reply`, directory: null,
      body: { answer: { q0: ['Phone', 'Desktop'], q1: 'Ship it' } },
    });
    assert.ok(frames.some((frame) => frame.kind === 'permission_resolved' && frame.requestId === 'form-question'));

    // Denying a form cancels it instead of answering.
    forms.push({ ...questionForm, id: 'form-denied' });
    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'form.created', data: { form: forms.at(-1) } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 1);
    openCodePermissionGateway.resolve('form-denied', { allow: false });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.equal(deletes.at(-1), `/api/session/${NATIVE_ID}/form/form-denied`);

    // A form raised by another feature (MCP elicitation) is not a question.
    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'form.created', data: {
      form: { id: 'form-elicitation', sessionID: NATIVE_ID, title: 'Authorize', metadata: { kind: 'mcp' },
        fields: [{ key: 'token', type: 'string' }] },
    } });
    assert.equal(openCodePermissionGateway.listPending(APP_ID).length, 0);

    // A pending form missed while disconnected is recovered by the snapshot sweep.
    forms.push({
      id: 'form-restored', sessionID: NATIVE_ID, title: 'Questions', metadata: { kind: 'question' },
      fields: [{ key: 'q0', title: 'Next', description: 'Continue?', type: 'string', options: [], custom: true }],
    });
    for (const stream of streams) stream.end();
    // A reconnect waits out the bridge's retry backoff before it can restore
    // the prompt, so this wait is longer than the default.
    await waitUntil(() => connections >= 3 && openCodePermissionGateway.listPending(APP_ID).length === 1, 1500);

    // The form.replied event settles it; the app is not notified again.
    forms.length = 0;
    handleOpenCodeEvent({ location: { directory: workspaceDirectory }, type: 'form.replied',
      data: { id: 'form-restored', sessionID: NATIVE_ID, answer: { q0: 'Yes' } } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.ok(frames.some((frame) => frame.kind === 'permission_resolved' && frame.requestId === 'form-restored'));
    assert.ok(frames.filter((frame) => frame.kind === 'permission_request').every((frame) => frame.provider === 'opencode' && frame.sessionId === APP_ID));
  } finally {
    stopOpenCodeBridge();
    connectedClients.clear();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('bridge replies with the 1.x `reply` field when the server answers health checks', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-legacy-reply-'));
  const frames: Request[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'evt-1', type: 'server.connected', data: {} })}\n\n`);
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    // A 1.x server answers this route with JSON; the 2.0 desktop server does not.
    if (url.pathname === '/global/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"healthy":true,"version":"1.18.33"}');
      return;
    }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      posts.push({ path: url.pathname, body: JSON.parse(body || '{}') });
      response.setHeader('Content-Type', 'application/json');
      response.end('{"data":{}}');
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    sessionsDb.createAppSession(APP_ID, 'opencode', '/workspace/opencode');
    sessionsDb.assignProviderSessionId(APP_ID, NATIVE_ID);
    connectedClients.add({ readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) } as never);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.OPENCODE_SERVER_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_BRIDGE_DISABLED;
    startOpenCodeBridge();

    handleOpenCodeEvent({ type: 'permission.asked', properties: {
      id: 'legacy-permission', sessionID: NATIVE_ID, action: 'bash',
    } });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 1);

    openCodePermissionGateway.resolve('legacy-permission', { allow: true });
    await waitUntil(() => openCodePermissionGateway.listPending(APP_ID).length === 0);
    assert.deepEqual(posts.at(-1), {
      path: `/api/session/${NATIVE_ID}/permission/legacy-permission/reply`,
      body: { reply: 'once' },
    });
  } finally {
    stopOpenCodeBridge();
    connectedClients.clear();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    delete process.env.OPENCODE_SERVER_URL;
    delete process.env.OPENCODE_BRIDGE_DISABLED;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
