import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/index.js';
import { handleOpenCodeEvent } from '@/modules/opencode-bridge/opencode-bridge.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const DIRECTORY = '/workspace/opencode';

/**
 * Minimal desktop-websocket stand-in: records every JSON frame so the test can
 * inspect which notifications the phone would have received.
 */
class FakeConnection {
  OPEN = 1;
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

/**
 * A bridge server stand-in. `handleOpenCodeEvent` only needs a non-null server
 * for the status/idle path; approval and question reconciliation are not
 * exercised here, so the URL is never dialed.
 */
const SERVER = { config: { url: 'http://127.0.0.1:9' } };

function completionCodes(connection: FakeConnection): string[] {
  return connection.frames
    .filter((frame) => frame.type === 'notification')
    .map((frame) => {
      const payload = frame.payload as { data?: { code?: string } } | undefined;
      return payload?.data?.code ?? '';
    });
}

/**
 * Sets up a phone that can receive notifications: one user, the desktop
 * channel enabled, an app session mapped to a provider-native id, and a
 * registered desktop endpoint.
 */
function withNotifiablePhone(
  appSessionId: string,
  providerSessionId: string,
): { phone: FakeConnection; userId: number } {
  const user = userDb.createUser('phone', 'hash');
  const userId = Number(user.id);
  notificationPreferencesDb.updatePreferences(userId, {
    channels: { inApp: false, webPush: false, desktop: true, sound: true },
    events: { actionRequired: true, stop: true, error: true },
  });
  sessionsDb.createAppSession(appSessionId, 'opencode', DIRECTORY);
  sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

  const phone = new FakeConnection();
  registerDesktopNotificationClient({ userId, deviceId: 'phone', ws: phone as never });
  return { phone, userId };
}

test('bridge pops a completion alert when an external OpenCode turn goes idle', async () => {
  await withIsolatedDatabase(() => {
    const { phone } = withNotifiablePhone('app-external', 'native-external');

    try {
      handleOpenCodeEvent(
        { type: 'session.status', properties: { sessionID: 'native-external', status: { type: 'busy' } } },
        SERVER as never,
      );
      assert.deepEqual(completionCodes(phone), []);

      handleOpenCodeEvent(
        { type: 'session.idle', properties: { sessionID: 'native-external' } },
        SERVER as never,
      );

      assert.deepEqual(completionCodes(phone), ['run.stopped']);
      const payload = phone.frames.at(-1)?.payload as {
        data: { sessionId: string; provider: string };
      };
      assert.equal(payload.data.sessionId, 'app-external');
      assert.equal(payload.data.provider, 'opencode');
    } finally {
      unregisterDesktopNotificationClient(phone as never);
    }
  });
});

test('bridge does not alert for a turn CloudCLI itself started', async () => {
  await withIsolatedDatabase(() => {
    const { phone, userId } = withNotifiablePhone('app-owned', 'native-owned');
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-owned',
      provider: 'opencode',
      providerSessionId: 'native-owned',
      connection: null,
      userId,
    });
    assert.ok(run);

    try {
      handleOpenCodeEvent(
        { type: 'session.status', properties: { sessionID: 'native-owned', status: { type: 'busy' } } },
        SERVER as never,
      );
      handleOpenCodeEvent(
        { type: 'session.idle', properties: { sessionID: 'native-owned' } },
        SERVER as never,
      );

      // The provider runtime owns the completion alert for this session.
      assert.deepEqual(completionCodes(phone), []);
    } finally {
      unregisterDesktopNotificationClient(phone as never);
    }
  });
});

test('bridge does not treat an idle session holding an approval as completed', async () => {
  await withIsolatedDatabase(() => {
    const { phone } = withNotifiablePhone('app-waiting', 'native-waiting');

    try {
      handleOpenCodeEvent(
        {
          type: 'permission.asked',
          properties: { id: 'waiting-permission', sessionID: 'native-waiting', permission: 'bash' },
        },
        SERVER as never,
      );
      handleOpenCodeEvent(
        { type: 'session.idle', properties: { sessionID: 'native-waiting' } },
        SERVER as never,
      );

      const codes = completionCodes(phone);
      assert.ok(codes.includes('permission.required'));
      assert.equal(codes.includes('run.stopped'), false);
    } finally {
      unregisterDesktopNotificationClient(phone as never);
    }
  });
});

test('bridge alerts a pending question as an interaction, not a completion', async () => {
  await withIsolatedDatabase(() => {
    const { phone } = withNotifiablePhone('app-question', 'native-question');

    try {
      handleOpenCodeEvent(
        {
          type: 'question.asked',
          properties: {
            id: 'waiting-question',
            sessionID: 'native-question',
            questions: [{ question: 'Continue?', header: 'Next', options: [] }],
          },
        },
        SERVER as never,
      );
      handleOpenCodeEvent(
        { type: 'session.idle', properties: { sessionID: 'native-question' } },
        SERVER as never,
      );

      const codes = completionCodes(phone);
      assert.ok(codes.includes('agent.notification'));
      assert.equal(codes.includes('run.stopped'), false);
    } finally {
      unregisterDesktopNotificationClient(phone as never);
    }
  });
});

test('bridge alerts a v2 form-backed question with the question text', async () => {
  await withIsolatedDatabase(() => {
    const { phone } = withNotifiablePhone('app-form-question', 'native-form-question');

    try {
      handleOpenCodeEvent(
        {
          type: 'form.created',
          data: {
            form: {
              id: 'frm_waiting',
              sessionID: 'native-form-question',
              title: 'Questions',
              metadata: { kind: 'question', tool: { messageID: 'message-1', id: 'tool-1' } },
              fields: [{ key: 'q0', title: 'Next', description: 'Continue?', type: 'string', options: [], custom: true }],
            },
          },
        },
        SERVER as never,
      );

      const payload = phone.frames
        .filter((frame) => frame.type === 'notification')
        .at(-1)?.payload as {
        data?: { code?: string; sessionId?: string };
        body?: string;
      } | undefined;
      assert.equal(payload?.data?.code, 'agent.notification');
      assert.equal(payload?.data?.sessionId, 'app-form-question');
      assert.ok(payload?.body?.includes('Continue?'));
    } finally {
      unregisterDesktopNotificationClient(phone as never);
    }
  });
});

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-bridge-notifications-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
