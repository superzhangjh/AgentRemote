/**
 * Bridge to the Android shell's on-device speech recognizer.
 *
 * The shell injects an `AgentRemoteVoice` JavaScript channel into the WebView and
 * calls `window.AgentRemoteVoiceBridge.dispatch` with recognition events. This module
 * is the only place that knows those global names, so the chat voice hooks can stay
 * free of shell-specific details. It is inert in a normal browser, where the channel
 * is absent and `hasNativeVoice` returns false.
 */

/** A single event pushed from the shell's speech recognizer. */
export type NativeVoiceEvent =
  | { type: 'ready' }
  | { type: 'processing' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'empty' }
  | { type: 'error'; message?: string; code?: number };

type NativeVoiceChannel = {
  postMessage: (message: string) => void;
};

type NativeVoiceDispatcher = {
  dispatch: (event: NativeVoiceEvent) => void;
};

function readChannel(): NativeVoiceChannel | null {
  if (typeof window === 'undefined') return null;
  const channel = (window as unknown as { AgentRemoteVoice?: NativeVoiceChannel }).AgentRemoteVoice;
  return channel && typeof channel.postMessage === 'function' ? channel : null;
}

/** True when the page is hosted by the Android shell with the native voice bridge. */
export function hasNativeVoice(): boolean {
  return readChannel() !== null;
}

/**
 * Routes native recognition events to `handler` and returns an unsubscribe function.
 * Only one handler is active at a time; a later subscription replaces an earlier one.
 */
export function subscribeNativeVoice(handler: (event: NativeVoiceEvent) => void): () => void {
  const bridge: NativeVoiceDispatcher = { dispatch: handler };
  const global = window as unknown as Record<string, unknown>;
  global.AgentRemoteVoiceBridge = bridge;
  return () => {
    if (global.AgentRemoteVoiceBridge === bridge) delete global.AgentRemoteVoiceBridge;
  };
}

function post(action: string, payload: Record<string, unknown> = {}): void {
  readChannel()?.postMessage(JSON.stringify({ action, ...payload }));
}

/** Starts on-device listening; `language` is a BCP-47 tag such as `zh-CN`. */
export function startNativeVoice(language?: string): void {
  post('start', language ? { language } : {});
}

/** Stops listening and lets the recognizer return its final transcript. */
export function stopNativeVoice(): void {
  post('stop');
}

/** Discards the current session without returning a transcript. */
export function cancelNativeVoice(): void {
  post('cancel');
}
