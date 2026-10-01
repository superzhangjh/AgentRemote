import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { resolveOpenCodeServerConfigs } from '@/shared/utils.js';
import {
  OpenCodeProviderModels,
  OPENCODE_PREDEFINED_MODELS,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { listOpenCodeServers } from '@/modules/providers/list/opencode/opencode-server.js';

/**
 * Runs one case with the SDK pointed at a closed port, so the catalog the
 * adapter reports depends on the fixture rather than on an OpenCode server the
 * developer running the suite happens to have listening on the default port.
 */
const withOpenCodeHome = async (
  runTest: (adapter: OpenCodeProviderModels) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-'));
  const originalHomedir = os.homedir;
  const originalServerUrl = process.env.OPENCODE_SERVER_URL;

  (os as any).homedir = () => homeDir;
  process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:1';

  try {
    await runTest(new OpenCodeProviderModels());
  } finally {
    (os as any).homedir = originalHomedir;
    if (originalServerUrl === undefined) delete process.env.OPENCODE_SERVER_URL;
    else process.env.OPENCODE_SERVER_URL = originalServerUrl;
    await rm(homeDir, { recursive: true, force: true });
  }
};

test('OpenCode uses the curated catalog when no server is reachable', async () => {
  await withOpenCodeHome(async (adapter) => {
    // Nothing readable from a server, so the picker keeps every option rather
    // than coming up empty.
    assert.deepEqual(await adapter.getSupportedModels(), OPENCODE_PREDEFINED_MODELS);
    assert.equal(
      (await adapter.getCurrentActiveModel()).model,
      OPENCODE_PREDEFINED_MODELS.DEFAULT,
    );
  });
  // OpenCode routes by `<providerID>/<modelID>`, so every option has to carry a
  // provider prefix the server reports.
  const providerIds = new Set(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value.split('/')[0]),
  );
  assert.deepEqual([...providerIds].sort(), ['anthropic', 'opencode', 'opencode-go', 'openai'].sort());
  assert.equal(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.every((option) => /^[a-z0-9-]+\/.+/.test(option.value)),
    true,
  );
  assert.equal(
    new Set(OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value)).size,
    OPENCODE_PREDEFINED_MODELS.OPTIONS.length,
  );
  assert.equal(OPENCODE_PREDEFINED_MODELS.DEFAULT, 'opencode/gpt-5.6-terra');
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'opencode/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'anthropic/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'openai/gpt-5.6'),
  );
  // The Go gateway carries its own provider id, so its models must be curated
  // too - a Go subscriber otherwise authenticates while the picker offers
  // nothing they can run.
  const opencodeGoOptions = OPENCODE_PREDEFINED_MODELS.OPTIONS.filter(
    (option) => option.value.startsWith('opencode-go/'),
  );
  assert.equal(opencodeGoOptions.length, 27);
  assert.ok(opencodeGoOptions.every((option) => option.description === 'OpenCode Go'));
  const glmFlash = opencodeGoOptions.find(
    (option) => option.value === 'opencode-go/glm-5.3-flash',
  );
  assert.ok(glmFlash);
  // Effort choices come from the server's model variants; the runtime turns a
  // selected value into `--variant`, so the values have to match exactly.
  assert.deepEqual(
    glmFlash?.effort?.values.map((value) => value.value),
    ['low', 'high', 'max'],
  );
  assert.ok(
    opencodeGoOptions
      .filter((option) => !option.effort)
      .every((option) =>
        ['glm-5.1', 'kimi-k2.6', 'kimi-k2.7-code', 'mimo-v2.5', 'mimo-v2.5-pro',
          'minimax-m2.7', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus']
          .includes(option.value.slice('opencode-go/'.length)),
      ),
  );
});

test('OpenCode reads models and reasoning variants from a running server', async () => {
  await withOpenCodeHome(async (adapter) => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return new Response(JSON.stringify({
        providers: [
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            models: {
              'deepseek-v4.1-flash': {
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                variants: {
                  low: { reasoningEffort: 'low' },
                  high: { reasoningEffort: 'high' },
                  max: { reasoningEffort: 'max' },
                },
              },
              'mimo-v2.5': { id: 'mimo-v2.5', name: 'MiMo V2.5', variants: {} },
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const models = await adapter.getSupportedModels();
      assert.equal(requestedUrl, 'http://127.0.0.1:4096/config/providers');
      assert.deepEqual(
        models.OPTIONS.map((option) => option.value),
        ['opencode-go/deepseek-v4.1-flash', 'opencode-go/mimo-v2.5'],
      );
      // The server's variants become the effort choices the composer offers.
      assert.deepEqual(
        models.OPTIONS[0].effort?.values.map((value) => value.value),
        ['low', 'high', 'max'],
      );
      // A model without variants exposes no effort section.
      assert.equal(models.OPTIONS[1].effort, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('OpenCode model catalog follows the selected desktop instance', async () => {
  await withOpenCodeHome(async (adapter) => {
    const previousFetch = globalThis.fetch;
    const previousDescriptor = process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
    const profileRoot = path.join(os.homedir(), '.opencode-profiles');
    for (const [name, port] of [['account-a', 4101], ['account-b', 4102]] as const) {
      const descriptor = path.join(profileRoot, name, 'state', 'opencode', 'service.json');
      fs.mkdirSync(path.dirname(descriptor), { recursive: true });
      fs.writeFileSync(descriptor, JSON.stringify({ url: `http://127.0.0.1:${port}`, password: '' }));
    }
    delete process.env.OPENCODE_SERVER_URL;
    const managedDescriptor = path.join(os.homedir(), 'agentremote.json');
    fs.writeFileSync(managedDescriptor, JSON.stringify({ url: 'http://127.0.0.1:4100' }));
    process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = managedDescriptor;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/session/active')) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const model = url.includes(':4102') ? 'account-b-model' : 'account-a-model';
      return new Response(JSON.stringify({ providers: [{ id: 'test', models: { [model]: { name: model } } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const selected = resolveOpenCodeServerConfigs().find((config) => config.url.endsWith(':4102'));
      assert.ok(selected?.id);
      const models = await adapter.getSupportedModels(selected.id);
      assert.deepEqual(models.OPTIONS.map((option) => option.value), ['test/account-b-model']);
      const processTable = [
        '/Applications/OpenCode.app/Contents/MacOS/OpenCode',
        `/Applications/OpenCode 2.app/Contents/MacOS/OpenCode XDG_STATE_HOME=${path.join(profileRoot, 'account-a', 'state')}`,
        `/Applications/OpenCode 3.app/Contents/MacOS/OpenCode XDG_STATE_HOME=${path.join(profileRoot, 'account-b', 'state')}`,
      ].join('\n');
      const choices = await listOpenCodeServers(processTable);
      assert.ok(choices[0]?.id.startsWith('service:'));
      assert.ok(choices[1]?.id.startsWith('service:'));
      assert.equal(choices.find((choice) => choice.id === 'agentremote')?.url, 'http://127.0.0.1:4100');
      const afterClosingSecondApp = await listOpenCodeServers(processTable.split('\n').slice(0, 2).join('\n'));
      assert.equal(afterClosingSecondApp.filter((choice) => choice.id.startsWith('service:')).length, 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousDescriptor === undefined) delete process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
      else process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = previousDescriptor;
    }
  });
});

test('OpenCode session model keeps its provider prefix', async () => {
  await withOpenCodeHome(async (adapter) => {
    const previousDatabasePath = process.env.DATABASE_PATH;
    const originalFetch = globalThis.fetch;
    closeConnection();
    process.env.DATABASE_PATH = path.join(os.homedir(), 'cloudcli.db');
    process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:4096';
    // The session's active model comes from the server's session record; the
    // SDK turns its `{ providerID, id }` pair into a `provider/model` route.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/session/ses_model')) {
        return new Response(JSON.stringify({
          id: 'ses_model',
          model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await initializeDatabase();
      assert.equal(
        (await adapter.getCurrentActiveModel('ses_model')).model,
        'opencode-go/deepseek-v4.1-flash',
      );
    } finally {
      globalThis.fetch = originalFetch;
      closeConnection();
      if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabasePath;
    }
  });
});
