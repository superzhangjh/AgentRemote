import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { sessionsService } from '@/modules/providers/index.js';
import { clearExternalSessionActivity, setExternalSessionActivity } from '@/modules/websocket/index.js';

test('running sessions include externally-managed OpenCode sessions', { concurrency: false }, async () => {
  clearExternalSessionActivity();
  setExternalSessionActivity('ses-external-1', 'opencode', true);

  try {
    const running = await sessionsService.listRunningSessions();
    const external = running.find((session) => session.sessionId === 'ses-external-1');
    assert.ok(external, 'external OpenCode session should be listed as running');
    assert.equal(external?.provider, 'opencode');
    assert.equal(external?.canInterrupt, false);
  } finally {
    clearExternalSessionActivity();
  }
});

test('running sessions drop an external session once it goes idle', { concurrency: false }, async () => {
  clearExternalSessionActivity();
  setExternalSessionActivity('ses-external-2', 'opencode', true);
  setExternalSessionActivity('ses-external-2', 'opencode', false);

  try {
    const running = await sessionsService.listRunningSessions();
    assert.equal(running.some((session) => session.sessionId === 'ses-external-2'), false);
  } finally {
    clearExternalSessionActivity();
  }
});

test('a native Codex turn is listed as externally running and cannot be interrupted', { concurrency: false }, async (t) => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'running-codex-'));
  const transcriptPath = path.join(tempDirectory, 'native.jsonl');
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    // A completed turn followed by a started one: the persisted boundary says
    // the session is mid-turn even though this app-server cannot observe it.
    const rows = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    sessionsDb.createSession('native-codex', 'codex', tempDirectory, 'Native Codex', undefined, undefined, transcriptPath);
    // A second app-server can report an external turn as idle. The shared
    // transcript still shows that it is running.
    t.mock.method(codexAppServer, 'getThreadActivity', async () => false);

    const running = await sessionsService.listRunningSessions('native-codex');
    const entry = running.find((session) => session.sessionId === 'native-codex');
    assert.equal(entry?.provider, 'codex');
    assert.equal(entry?.canInterrupt, false);
    assert.equal(entry?.statusText, '外部运行中');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
