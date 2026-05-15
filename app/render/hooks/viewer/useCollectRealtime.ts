'use client';

import { useRef, useCallback } from 'react';

const SAMPLE_RATE = 24000;
const CHUNK_SAMPLES = 4096;

export interface CollectRealtimeCallbacks {
  onDelta: (interimText: string) => void;
  onCompleted: (text: string) => void;
  onError: (message: string) => void;
  onGptFollowUp?: (message: string) => void;
  onGptThinking?: (thinking: boolean) => void;
}

/**
 * Real-time transcription: connect to backend WebSocket (OpenAI Realtime proxy),
 * capture mic at 24kHz PCM, send base64 chunks; call onDelta/onCompleted.
 * Backend may send gpt_thinking (show "..." then onGptThinking(true)) and gpt_follow_up (onGptThinking(false) + onGptFollowUp).
 * Use sendViewport({ x, y, w, h }) with OSD image pixel coordinates so the trigger can crop the slide.
 */
export function useCollectRealtime(): {
  start: (wsUrl: string, callbacks: CollectRealtimeCallbacks) => Promise<void>;
  stop: () => void;
  sendViewport: (viewport: { x: number; y: number; w: number; h: number }) => void;
} {
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const interimRef = useRef('');

  const stop = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (contextRef.current) {
      contextRef.current.close().catch(() => {});
      contextRef.current = null;
    }
    interimRef.current = '';
  }, []);

  const sendViewport = useCallback((viewport: { x: number; y: number; w: number; h: number }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'viewport', ...viewport }));
      } catch (_) {}
    }
  }, []);

  const start = useCallback(
    async (wsUrl: string, callbacks: CollectRealtimeCallbacks) => {
      stop();
      interimRef.current = '';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const context = new AudioContext({ sampleRate: SAMPLE_RATE });
        contextRef.current = context;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error('WebSocket failed'));
          setTimeout(() => reject(new Error('WebSocket timeout')), 10000);
        });

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            const t = data.type;
            if (t === 'conversation.item.input_audio_transcription.delta' && data.delta != null) {
              interimRef.current += data.delta;
              callbacks.onDelta(interimRef.current);
            } else if (t === 'conversation.item.input_audio_transcription.completed' && data.transcript != null) {
              const text = String(data.transcript).trim();
              if (text) callbacks.onCompleted(text);
              interimRef.current = '';
              callbacks.onDelta('');
            } else if (t === 'gpt_thinking') {
              callbacks.onGptThinking?.(true);
            } else if (t === 'gpt_follow_up') {
              callbacks.onGptThinking?.(false);
              const msg = data.message != null ? String(data.message) : '';
              if (msg && callbacks.onGptFollowUp) callbacks.onGptFollowUp(msg);
            } else if (t === 'error') {
              callbacks.onError(data.error?.message ?? 'Realtime error');
            }
          } catch (_) {}
        };
        ws.onerror = () => callbacks.onError('WebSocket error');
        ws.onclose = () => {};

        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
        source.connect(processor);

        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const u8 = new Uint8Array(pcm.buffer);
          let binary = '';
          for (let i = 0; i < u8.length; i += 4096) {
            binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 4096)));
          }
          const b64 = btoa(binary);
          try {
            wsRef.current.send(JSON.stringify({ type: 'audio', data: b64 }));
          } catch (_) {}
        };
        processor.connect(context.createMediaStreamDestination());
      } catch (err) {
        stop();
        callbacks.onError(err instanceof Error ? err.message : 'Failed to start realtime');
      }
    },
    [stop]
  );

  return { start, stop, sendViewport };
}
