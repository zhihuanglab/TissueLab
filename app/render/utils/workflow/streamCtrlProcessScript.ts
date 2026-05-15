/**
 * Consume Ctrl-Service `POST /api/agent/v1/process_script_stream` (text/event-stream).
 * Each line: `data: {"delta"|"done"|"error": ...}`
 */
export async function readProcessScriptSse(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onDelta: (accumulatedRaw: string) => void;
    onDone: (code: string) => void;
    onStreamError: (message: string) => void;
  },
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payloadStr = trimmed.slice(5).trim();
        try {
          const evt = JSON.parse(payloadStr) as Record<string, unknown>;
          if (typeof evt.delta === "string" && evt.delta) {
            accumulated += evt.delta;
            handlers.onDelta(accumulated);
          }
          if (evt.error != null) {
            const msg = String(evt.error);
            handlers.onStreamError(msg);
            return { ok: false, error: msg };
          }
          if (evt.done === true) {
            const code = typeof evt.code === "string" ? evt.code : "";
            handlers.onDone(code);
            return { ok: true, code };
          }
        } catch {
          /* incomplete JSON line */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return { ok: false, error: "Stream ended without completion" };
}
