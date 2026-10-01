import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveServerConfig, resolveServerConfigs } from '@/modules/opencode-bridge/opencode-bridge.service.js';

/**
 * Runs `run` with the AgentRemote OpenCode server descriptor pointed at
 * `descriptor`, restoring the previous environment afterwards so the test does
 * not leak configuration into the rest of the file.
 */
function withDescriptor(descriptor: string, run: () => void): void {
  const previousFile = process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
  const previousUrl = process.env.OPENCODE_SERVER_URL;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bridge-')),
    'opencode-server.json',
  );

  fs.writeFileSync(file, descriptor);
  process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = file;
  delete process.env.OPENCODE_SERVER_URL;
  delete process.env.OPENCODE_SERVER_PASSWORD;

  try {
    run();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    restore('AGENT_REMOTE_OPENCODE_STATE_FILE', previousFile);
    restore('OPENCODE_SERVER_URL', previousUrl);
    restore('OPENCODE_SERVER_PASSWORD', previousPassword);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('bridge mirrors the server advertised by the AgentRemote descriptor', () => {
  withDescriptor('{"url":"http://127.0.0.1:56083"}', () => {
    // The managed server is unsecured, so no auth header is attached.
    assert.deepEqual(resolveServerConfig(), {
      url: 'http://127.0.0.1:56083',
      headers: {},
      id: 'agentremote',
      label: 'OpenCode · AgentRemote CLI',
    });
  });
});

test('an explicit OPENCODE_SERVER_URL still wins over the descriptor', () => {
  withDescriptor('{"url":"http://127.0.0.1:56083"}', () => {
    process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:1234';
    assert.equal(resolveServerConfig().url, 'http://127.0.0.1:1234');
  });
});

test('an unreadable descriptor is ignored', () => {
  const previousFile = process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
  const previousUrl = process.env.OPENCODE_SERVER_URL;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const previousUser = process.env.OPENCODE_SERVER_USERNAME;
  // A password makes the resolver return before touching process discovery, so
  // the assertion does not depend on what is running on the test machine.
  process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = path.join(
    os.tmpdir(),
    'does-not-exist',
    'opencode-server.json',
  );
  delete process.env.OPENCODE_SERVER_URL;
  process.env.OPENCODE_SERVER_PASSWORD = 'secret';
  process.env.OPENCODE_SERVER_USERNAME = 'tester';

  try {
    const config = resolveServerConfig();
    assert.equal(config.url, 'http://127.0.0.1:4096');
    assert.deepEqual(config.headers, {
      Authorization: `Basic ${Buffer.from('tester:secret', 'utf8').toString('base64')}`,
    });
  } finally {
    restore('AGENT_REMOTE_OPENCODE_STATE_FILE', previousFile);
    restore('OPENCODE_SERVER_URL', previousUrl);
    restore('OPENCODE_SERVER_PASSWORD', previousPassword);
    restore('OPENCODE_SERVER_USERNAME', previousUser);
  }
});

test('resolveServerConfigs discovers a v2 background service descriptor', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'));
  const stateDir = path.join(home, '.local', 'state', 'opencode');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'service.json'),
    JSON.stringify({ url: 'http://127.0.0.1:49999', password: 'pw' }),
  );
  const previousHome = process.env.HOME;
  const previousFile = process.env.AGENT_REMOTE_OPENCODE_STATE_FILE;
  const previousUrl = process.env.OPENCODE_SERVER_URL;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;

  process.env.HOME = home;
  process.env.AGENT_REMOTE_OPENCODE_STATE_FILE = path.join(home, 'missing.json');
  delete process.env.OPENCODE_SERVER_URL;
  delete process.env.OPENCODE_SERVER_PASSWORD;

  try {
    const configs = resolveServerConfigs();
    const service = configs.find((config) => config.url === 'http://127.0.0.1:49999');
    assert.ok(service, `expected the service descriptor, saw ${configs.map((config) => config.url).join(', ')}`);
    assert.deepEqual(service?.headers, {
      Authorization: `Basic ${Buffer.from('opencode:pw', 'utf8').toString('base64')}`,
    });
    assert.match(service?.id ?? '', /^service:[a-f0-9]{16}$/);
    assert.equal(service?.label, 'OpenCode · Default');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    restore('HOME', previousHome);
    restore('AGENT_REMOTE_OPENCODE_STATE_FILE', previousFile);
    restore('OPENCODE_SERVER_URL', previousUrl);
    restore('OPENCODE_SERVER_PASSWORD', previousPassword);
  }
});
