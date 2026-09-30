import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isOpenCodeQuestionAllowed,
  opencodeRuntime,
  resolveOpenCodePermissionOptions,
} from './opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId || null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeOpenCodeExecutable(binDir) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
const args = process.argv.slice(2);
if (capturePath) {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({
    args,
    permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
  }));
}

// Mirror the real CLI: a resumed run reports the session it was handed.
const sessionFlagIndex = args.indexOf('--session');
const sessionID = sessionFlagIndex !== -1 ? args[sessionFlagIndex + 1] : 'open-live-1';

const events = [
  { type: 'text', sessionID, text: 'assistant response' },
  { type: 'step_finish', sessionID },
];

for (const event of events) {
  console.log(JSON.stringify(event));
}
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

/**
 * Runs `body` with the CLI discovery environment pointed at `tempRoot`, so the
 * fake `opencode` executable is used and — unless the test writes one — no
 * shared-server descriptor is found. Without this the runtime would reach the
 * developer's real `opencode serve` instance.
 */
async function withCliEnv(tempRoot, body) {
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const previousStateFile = process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;

  process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
  process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = path.join(tempRoot, 'no-server.json');
  if (process.platform === 'win32') {
    process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
      ? previousPathExt
      : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
  }

  try {
    await body();
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;

    if (previousPathExt === undefined) delete process.env[pathExtKey];
    else process.env[pathExtKey] = previousPathExt;

    if (previousArgsCapture === undefined) delete process.env.OPENCODE_ARGS_CAPTURE;
    else process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;

    if (previousStateFile === undefined) delete process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
    else process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = previousStateFile;
  }
}

function createWriter(messages = []) {
  return {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };
}

/**
 * Minimal stand-in for the OpenCode HTTP server, covering only the session
 * create/get/update calls the runtime makes before spawning the CLI.
 */
async function startStubServer(handlers = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname });

    const handler = handlers[`${request.method} ${url.pathname}`];
    if (!handler) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let rawBody = '';
    request.on('data', (chunk) => { rawBody += chunk; });
    request.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) : {};
      const result = handler(body) ?? {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-live-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const messages = [];
  const writer = createWriter(messages);

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withCliEnv(tempRoot, async () => {
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

      const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
      const assistantDeltaIndex = messages.findIndex((message) =>
        message.kind === 'stream_delta' && message.content === 'assistant response',
      );
      const streamEnd = messages.find((message) => message.kind === 'stream_end');
      const complete = messages.find((message) => message.kind === 'complete');

      assert.notEqual(sessionCreatedIndex, -1);
      assert.notEqual(assistantDeltaIndex, -1);
      assert.ok(sessionCreatedIndex < assistantDeltaIndex);
      assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
      assert.equal(writer.sessionId, 'open-live-1');
      assert.equal(streamEnd?.sessionId, 'open-live-1');
      assert.equal(complete?.sessionId, 'open-live-1');
      assert.equal(messages.some((message) => message.kind === 'error'), false);

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      const launchedArgs = capture.args;
      assert.ok(Array.isArray(launchedArgs));
      assert.deepEqual(launchedArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
      assert.equal(launchedArgs[4], tempRoot);
      // No shared server → the CLI creates the session itself.
      assert.equal(launchedArgs.includes('--session'), false);
      assert.equal(launchedArgs.includes('--attach'), false);
      // No permission mode requested → no permission flags and no env override.
      assert.equal(launchedArgs.includes('--auto'), false);
      assert.equal(launchedArgs.includes('--agent'), false);
      assert.equal(capture.permissionEnv, null);

      const attachmentOnlyCapturePath = path.join(tempRoot, 'opencode-attachment-only.json');
      process.env.OPENCODE_ARGS_CAPTURE = attachmentOnlyCapturePath;
      await opencodeRuntime.run(
        '',
        {
          cwd: tempRoot,
          files: [{
            path: path.join(tempRoot, 'brief.pdf'),
            name: 'brief.pdf',
            mimeType: 'application/pdf',
          }],
        },
        writer,
        runtimeContext,
      );
      const attachmentOnlyCapture = JSON.parse(await readFile(attachmentOnlyCapturePath, 'utf8'));
      const attachmentPrompt = attachmentOnlyCapture.args[attachmentOnlyCapture.args.length - 1];
      assert.match(attachmentPrompt, /<files_input>/);
      assert.match(attachmentPrompt, /brief\.pdf/);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode attaches to the console-managed server when its descriptor exists', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-attach-'));
  const descriptorPath = path.join(tempRoot, 'opencode-server.json');
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const writer = createWriter();

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withCliEnv(tempRoot, async () => {
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      // No descriptor → OpenCode owns its local server as before.
      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);
      const defaultCapture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      assert.equal(defaultCapture.args.includes('--attach'), false);

      // Descriptor present → the run attaches to the advertised server URL.
      await writeFile(descriptorPath, JSON.stringify({
        url: 'http://127.0.0.1:49123',
        host: '0.0.0.0',
        port: 49123,
      }), 'utf8');
      process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = descriptorPath;
      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);
      const attachedCapture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      const attachIndex = attachedCapture.args.indexOf('--attach');
      assert.notEqual(attachIndex, -1);
      assert.equal(attachedCapture.args[attachIndex + 1], 'http://127.0.0.1:49123');
      assert.equal(attachedCapture.args[attachedCapture.args.length - 1], 'Hi');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveOpenCodePermissionOptions maps UI permission modes onto OpenCode controls', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), {
    args: ['--agent', 'plan'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), {
    args: ['--auto'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  // default and anything unknown leave the user's own opencode config in charge.
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

test('spawnOpenCode passes permission mode flags and env to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-perms-'));
  const writer = createWriter();

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await withCliEnv(tempRoot, async () => {
      const scenarios = [
        {
          permissionMode: 'plan',
          expectArgs: ['--agent', 'plan'],
          expectPermissionEnv: null,
        },
        {
          permissionMode: 'bypassPermissions',
          expectArgs: ['--auto'],
          expectPermissionEnv: null,
        },
        {
          permissionMode: 'acceptEdits',
          expectArgs: [],
          expectPermissionEnv: '{"edit":"allow"}',
        },
      ];

      for (const scenario of scenarios) {
        const argsCapturePath = path.join(tempRoot, `opencode-args-${scenario.permissionMode}.json`);
        process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

        await opencodeRuntime.run(
          'Hi',
          { cwd: tempRoot, permissionMode: scenario.permissionMode },
          writer,
          runtimeContext,
        );

        const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
        for (const expectedArg of scenario.expectArgs) {
          assert.ok(
            capture.args.includes(expectedArg),
            `${scenario.permissionMode}: expected "${expectedArg}" in ${JSON.stringify(capture.args)}`,
          );
        }
        // The prompt stays the last positional argument, after any permission flags.
        assert.equal(capture.args[capture.args.length - 1], 'Hi');
        assert.equal(capture.permissionEnv, scenario.expectPermissionEnv);
      }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('isOpenCodeQuestionAllowed reads the last matching question rule', () => {
  // No ruleset at all (a server-created session) leaves the tool allowed.
  assert.equal(isOpenCodeQuestionAllowed(undefined), true);
  assert.equal(isOpenCodeQuestionAllowed([]), true);
  // The CLI's seeded deny blocks it.
  assert.equal(
    isOpenCodeQuestionAllowed([{ permission: 'question', pattern: '*', action: 'deny' }]),
    false,
  );
  // An append-only allow rule wins because the last matching rule decides.
  assert.equal(
    isOpenCodeQuestionAllowed([
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'allow' },
    ]),
    true,
  );
  // A trailing deny re-blocks it.
  assert.equal(
    isOpenCodeQuestionAllowed([
      { permission: 'question', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'deny' },
    ]),
    false,
  );
});

test('spawnOpenCode creates the session on the shared server so questions are allowed', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-server-'));
  const descriptorPath = path.join(tempRoot, 'opencode-server.json');
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const messages = [];
  const writer = createWriter(messages);
  const stub = await startStubServer({
    'POST /session': () => ({ id: 'ses_stubbed', directory: tempRoot }),
  });

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await writeFile(descriptorPath, JSON.stringify({ url: stub.url, host: '127.0.0.1', port: 0 }), 'utf8');
    await withCliEnv(tempRoot, async () => {
      process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = descriptorPath;
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      const sessionIndex = capture.args.indexOf('--session');
      assert.notEqual(sessionIndex, -1);
      assert.equal(capture.args[sessionIndex + 1], 'ses_stubbed');

      // The session id is registered with the app before the run.
      const created = messages.find((message) => message.kind === 'session_created');
      assert.equal(created?.newSessionId, 'ses_stubbed');
      assert.equal(writer.sessionId, 'ses_stubbed');

      assert.ok(
        stub.requests.some((request) => request.method === 'POST' && request.path === '/session'),
        `expected a POST /session, saw ${JSON.stringify(stub.requests)}`,
      );
    });
  } finally {
    await stub.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('spawnOpenCode repairs a resumed session whose question permission is denied', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-resume-'));
  const descriptorPath = path.join(tempRoot, 'opencode-server.json');
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const providerSessionId = 'ses_existing_provider';
  const resumeContext = {
    ...runtimeContext,
    resolveProviderSessionId: () => providerSessionId,
  };
  const writer = createWriter();
  const stub = await startStubServer({
    [`GET /session/${providerSessionId}`]: () => ({
      id: providerSessionId,
      directory: tempRoot,
      permission: [{ permission: 'question', pattern: '*', action: 'deny' }],
    }),
    [`PATCH /session/${providerSessionId}`]: () => ({
      id: providerSessionId,
      permission: [
        { permission: 'question', pattern: '*', action: 'deny' },
        { permission: 'question', pattern: '*', action: 'allow' },
      ],
    }),
  });

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    await writeFile(descriptorPath, JSON.stringify({ url: stub.url, host: '127.0.0.1', port: 0 }), 'utf8');
    await withCliEnv(tempRoot, async () => {
      process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = descriptorPath;
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, resumeContext);

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      const sessionIndex = capture.args.indexOf('--session');
      assert.notEqual(sessionIndex, -1);
      assert.equal(capture.args[sessionIndex + 1], providerSessionId);

      assert.ok(
        stub.requests.some(
          (request) => request.method === 'PATCH' && request.path === `/session/${providerSessionId}`,
        ),
        `expected a PATCH /session/{id}, saw ${JSON.stringify(stub.requests)}`,
      );
    });
  } finally {
    await stub.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
