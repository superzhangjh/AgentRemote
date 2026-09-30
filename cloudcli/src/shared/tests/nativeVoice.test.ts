import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import {
  cancelNativeVoice,
  hasNativeVoice,
  startNativeVoice,
  stopNativeVoice,
  subscribeNativeVoice,
} from '@/shared/nativeVoice';

/**
 * The native voice bridge is the only link between the composer and the Android
 * shell's on-device recognizer. It must stay inert in a plain browser (where the
 * injected channel is absent) and must post the exact action names the shell parses.
 */

type Posted = { action: string; language?: string };

const messages: string[] = [];

function installChannel() {
  Object.defineProperty(window, 'AgentRemoteVoice', {
    configurable: true,
    writable: true,
    value: { postMessage: (message: string) => messages.push(message) },
  });
}

afterEach(() => {
  messages.length = 0;
  delete (window as unknown as Record<string, unknown>).AgentRemoteVoice;
  delete (window as unknown as Record<string, unknown>).AgentRemoteVoiceBridge;
});

test('the bridge is unavailable without the injected channel', () => {
  assert.equal(hasNativeVoice(), false);
  // Calling without the channel must be a no-op rather than throwing.
  startNativeVoice('zh-CN');
  stopNativeVoice();
  cancelNativeVoice();
  assert.equal(messages.length, 0);
});

test('start, stop and cancel post their action names', () => {
  installChannel();

  startNativeVoice('zh-CN');
  stopNativeVoice();
  cancelNativeVoice();

  assert.deepEqual(
    messages.map((message) => JSON.parse(message) as Posted),
    [{ action: 'start', language: 'zh-CN' }, { action: 'stop' }, { action: 'cancel' }],
  );
});

test('start without a language omits the field', () => {
  installChannel();

  startNativeVoice();

  assert.deepEqual(JSON.parse(messages[0]) as Posted, { action: 'start' });
});

test('a subscriber receives dispatched events until it unsubscribes', () => {
  const received: unknown[] = [];
  const unsubscribe = subscribeNativeVoice((event) => received.push(event));
  const bridge = (window as unknown as Record<string, { dispatch: (e: unknown) => void }>)
    .AgentRemoteVoiceBridge;

  bridge.dispatch({ type: 'final', text: '你好' });
  assert.deepEqual(received, [{ type: 'final', text: '你好' }]);

  unsubscribe();
  assert.equal(
    (window as unknown as Record<string, unknown>).AgentRemoteVoiceBridge,
    undefined,
  );
});
