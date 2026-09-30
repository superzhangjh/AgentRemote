import { useCallback, useEffect, useRef, useState } from 'react';

import { transcribeVoice } from '@/shared/api';
import {
  cancelNativeVoice,
  hasNativeVoice,
  startNativeVoice,
  stopNativeVoice,
  subscribeNativeVoice,
} from '@/shared/nativeVoice';
import type { VoiceInputState } from '@/shared/types';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}


/**
 * Push-to-talk dictation. Inside the Android shell it drives the native on-device
 * recognizer through the bridge in `shared/nativeVoice`; in a browser it records the
 * mic and uploads to /api/voice/transcribe (an OpenAI-compatible speech-to-text
 * backend via the Express proxy). Either way the transcript returns through onTranscript.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // Native recognition is decided once per mount; the shell does not appear mid-session.
  const nativeRef = useRef(hasNativeVoice());
  // Native events arrive asynchronously through a global bridge, so callbacks and the
  // send intent are kept in refs to avoid resubscribing on every render.
  const nativeTranscriptRef = useRef(onTranscript);
  const nativeErrorRef = useRef(onError);
  const nativeSendRef = useRef(false);
  const nativeActiveRef = useRef(false);

  useEffect(() => {
    nativeTranscriptRef.current = onTranscript;
    nativeErrorRef.current = onError;
  }, [onTranscript, onError]);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Route native recognizer events into the same transcript/error callbacks.
  useEffect(() => {
    if (!nativeRef.current) return;
    return subscribeNativeVoice((event) => {
      switch (event.type) {
        case 'final': {
          const shouldSend = nativeSendRef.current;
          nativeSendRef.current = false;
          nativeActiveRef.current = false;
          setState('idle');
          if (event.text) nativeTranscriptRef.current(event.text, shouldSend);
          else nativeErrorRef.current?.('No speech detected');
          break;
        }
        case 'empty':
          nativeSendRef.current = false;
          nativeActiveRef.current = false;
          setState('idle');
          nativeErrorRef.current?.('No speech detected');
          break;
        case 'error':
          nativeSendRef.current = false;
          nativeActiveRef.current = false;
          setState('idle');
          nativeErrorRef.current?.(event.message || 'Transcription failed');
          break;
        case 'ready':
        case 'processing':
        case 'partial':
          // Partial transcripts are intentionally ignored; only the final result is used.
          break;
      }
    });
  }, []);

  // Stop the mic or the native recognizer if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    const usesNativeVoice = nativeRef.current;
    return () => {
      cancelledRef.current = true;
      startingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      if (usesNativeVoice && nativeActiveRef.current) cancelNativeVoice();
      nativeActiveRef.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    if (nativeRef.current) {
      if (nativeActiveRef.current) return;
      nativeActiveRef.current = true;
      nativeSendRef.current = false;
      setState('recording');
      startNativeVoice(typeof navigator !== 'undefined' ? navigator.language : undefined);
      return;
    }
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        stopTracks();
        if (cancelledRef.current) return;
        // Capture and clear the send intent for this stop before any async work.
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size < 800) {
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        setState('transcribing');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current) return;
          const text = String(data?.text || '').trim();
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
        } catch (e) {
          if (!cancelledRef.current) {
            onError?.(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } finally {
          if (!cancelledRef.current) setState('idle');
        }
      };

      rec.start();
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [onTranscript, onError]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    if (nativeRef.current) {
      if (!nativeActiveRef.current) return;
      nativeSendRef.current = opts?.send ?? false;
      nativeActiveRef.current = false;
      setState('transcribing');
      stopNativeVoice();
      return;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, toggle, stop };
}
