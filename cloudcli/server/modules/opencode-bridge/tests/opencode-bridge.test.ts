import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveServerConfig } from '@/modules/opencode-bridge/opencode-bridge.service.js';

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
