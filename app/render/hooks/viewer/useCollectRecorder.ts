'use client';

import { useRef, useState, useMemo } from 'react';

/**
 * Records microphone to a blob for uploading to backend (OpenAI Whisper API).
 */
export function useCollectRecorder(): {
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
  isRecording: boolean;
} {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  return useMemo(() => ({
    isRecording: false,
    start: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(1000);
        setIsRecording(true);
      } catch (err) {
        console.error('[useCollectRecorder] start failed:', err);
      }
    },
    stop: (): Promise<Blob | null> => {
      return new Promise((resolve) => {
        const recorder = mediaRecorderRef.current;
        const stream = streamRef.current;
        if (!recorder || recorder.state === 'inactive') {
          if (stream) stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          mediaRecorderRef.current = null;
          setIsRecording(false);
          resolve(null);
          return;
        }
        recorder.onstop = () => {
          if (stream) stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          mediaRecorderRef.current = null;
          setIsRecording(false);
          const blob =
            chunksRef.current.length > 0
              ? new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
              : null;
          chunksRef.current = [];
          resolve(blob);
        };
        recorder.stop();
      });
    },
  }), []);
}
