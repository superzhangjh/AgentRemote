import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcastScheduledMessagesUpdated } from '@/modules/websocket/services/scheduled-messages-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('a scheduled-message change reaches every open client with its session id', () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  connectedClients.add(first as never);
  connectedClients.add(second as never);

  try {
    broadcastScheduledMessagesUpdated('session-1');
  } finally {
    connectedClients.clear();
  }

  for (const connection of [first, second]) {
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'scheduled_messages_updated');
    assert.equal(connection.frames[0].sessionId, 'session-1');
    assert.equal(typeof connection.frames[0].timestamp, 'string');
  }
});

test('closed sockets are skipped', () => {
  const closed = new FakeConnection();
  closed.readyState = 3; // CLOSED
  const open = new FakeConnection();
  connectedClients.add(closed as never);
  connectedClients.add(open as never);

  try {
    broadcastScheduledMessagesUpdated('session-1');
  } finally {
    connectedClients.clear();
  }

  assert.equal(closed.frames.length, 0);
  assert.equal(open.frames.length, 1);
});

test('a missing session id is not announced', () => {
  const connection = new FakeConnection();
  connectedClients.add(connection as never);

  try {
    broadcastScheduledMessagesUpdated('');
  } finally {
    connectedClients.clear();
  }

  assert.equal(connection.frames.length, 0);
});
