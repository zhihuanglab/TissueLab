import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import type { AppDispatch } from "@/store";
import { addMessage } from "@/store/slices/chat/chatSlice";
import { apiFetch } from "@/utils/common/apiFetch";
import EventBus from "@/utils/EventBus";

export type RunCodingAgentScriptChainParams = {
  code: string;
  zarrPath: string;
  userPrompt: string;
  agentId: string;
  apiVersion: "v1" | "v2";
  dispatch: AppDispatch;
  /**
   * After a successful run, also open the Bot tab (sidebar chat).
   * Default false — embedded Coding Agent / workflow auto-run usually stay on the current view.
   */
  openBotSidebar?: boolean;
  /**
   * On execute_script / summary_answer failure or client-side exception: post a Bot message and
   * switch to the Bot tab so the user sees the error and next steps. Default true.
   */
  openBotOnError?: boolean;
};

export type RunCodingAgentScriptChainResult = {
  ok: boolean;
  /** App-level status code from backend envelope (0 = success). */
  statusCode: number;
  /** Which stage returned the statusCode/error. */
  stage: "execute_script" | "summary_answer" | "client";
  error?: string;
  /** Summary body pushed to Bot chat and Run-tab summary panel. */
  chatBody?: string;
  /** Stringified execution_result from execute_script (Run-tab raw panel). */
  rawOutput?: string;
};

const FALLBACK_PREVIEW_CHARS = 6000;

const REGENERATE_HINT =
  "Need to regenerate code? Open **Workflow Graph** → select the **Coding Agent / GPT-4o Agent** node → the **Generate** tab and rerun the workflow, or describe in this chat how you want it changed.";

function navigateToBotSidebar() {
  EventBus.emit("open-sidebar", "SidebarChat");
  EventBus.emit("switchTab", "bot");
}

function postBotErrorAndNavigate(
  dispatch: AppDispatch,
  headline: string,
  detail: string,
) {
  const body = `${headline}\n\n${detail}\n\n---\n${REGENERATE_HINT}`;
  try {
    dispatch(
      addMessage({
        id: Date.now(),
        content: { type: "text", content: body } as any,
        sender: "bot",
        type: "text",
      } as any),
    );
  } catch {
    /* ignore */
  }
  navigateToBotSidebar();
}

/**
 * Tasks `summary_answer` returns AppResponse `{ code, data }`; apiFetch unwraps so `resp.data` is usually
 * `{ agent_id, response, parameters, control_error? }`. Older callers might still see nested `{ code, data }`.
 */
function extractSummaryText(sumRespData: unknown): string {
  if (!sumRespData || typeof sumRespData !== "object") return "";
  const o = sumRespData as Record<string, unknown>;

  const top = o.response ?? o.summary;
  if (typeof top === "string" && top.trim()) return top.trim();

  if (o.code === 0 && o.data != null && typeof o.data === "object") {
    const d = o.data as Record<string, unknown>;
    const nested = d.response ?? d.summary;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }

  return "";
}

function executionFallbackChatBody(execJson: string): string {
  const t = execJson.trim();
  if (!t) return "The script ran; the server did not return usable summary text.";
  if (t.length <= FALLBACK_PREVIEW_CHARS) {
    return `Raw output from this run (shown automatically when the summary endpoint returns no body):\n\n\`\`\`json\n${t}\n\`\`\``;
  }
  return `Raw output excerpt from this run (shown automatically when the summary endpoint returns no body):\n\n\`\`\`json\n${t.slice(0, FALLBACK_PREVIEW_CHARS)}\n\`\`\`\n\n…(truncated)`;
}

function readEnvelopeCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  return typeof obj.code === "number" ? obj.code : undefined;
}

function readEnvelopeMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  return typeof obj.message === "string" ? obj.message : undefined;
}

/**
 * execute_script → summary_answer → Bot chat message(s).
 */
export async function runCodingAgentScriptChain(
  params: RunCodingAgentScriptChainParams,
): Promise<RunCodingAgentScriptChainResult> {
  const {
    code,
    zarrPath,
    userPrompt,
    agentId,
    apiVersion,
    dispatch,
    openBotSidebar = false,
    openBotOnError = true,
  } = params;

  try {
    const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/${apiVersion}/execute_script`, {
      method: "POST",
      body: JSON.stringify({ zarr_path: zarrPath, code_str: code }),
      returnAxiosFormat: true,
    });

    const envelope = resp.data as Record<string, unknown> | undefined;

    const execCode = readEnvelopeCode(envelope);
    if (typeof execCode === "number" && execCode !== 0) {
      const msg = readEnvelopeMessage(envelope) || "Script execution failed";
      if (openBotOnError) {
        postBotErrorAndNavigate(
          dispatch,
          `Code execution failed (execute_script, status code ${execCode})`,
          msg,
        );
      }
      return { ok: false, statusCode: execCode, stage: "execute_script", error: msg };
    }

    const execData = (envelope?.data as Record<string, unknown> | undefined) ?? envelope;
    const exec = (execData as any)?.execution_result ?? execData;
    const rawOutput = typeof exec === "string" ? exec : JSON.stringify(exec, null, 2);

    const sumResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/${apiVersion}/summary_answer`, {
      method: "POST",
      body: JSON.stringify({
        agent_id: agentId,
        prompt: userPrompt
          ? `We've just executed a script for this prompt: "${userPrompt}". Please provide a concise summary of the results.`
          : "We've just executed a script. Please provide a concise summary of the results.",
        parameters: { answer: rawOutput },
      }),
      returnAxiosFormat: true,
    });
    const summaryCode = readEnvelopeCode(sumResp.data);
    if (typeof summaryCode === "number" && summaryCode !== 0) {
      const msg = readEnvelopeMessage(sumResp.data) || "Summary generation failed";
      if (openBotOnError) {
        postBotErrorAndNavigate(
          dispatch,
          `Summary generation failed (summary_answer, status code ${summaryCode})`,
          `${msg}\n\nRaw output from the execution phase is available in Agentic AI → Run.`,
        );
      }
      return {
        ok: false,
        statusCode: summaryCode,
        stage: "summary_answer",
        error: msg,
        rawOutput,
      };
    }

    const summaryText = extractSummaryText(sumResp.data);

    const chatBody = summaryText.trim()
      ? summaryText.trim()
      : executionFallbackChatBody(rawOutput);

    // NOTE: do not dispatch addMessage here. The Chatbox `isGenerating`
    // polling loop reads cur_answer from /tasks/v1/get_answer (which
    // post_answer fills on the backend after summary_answer returns) and
    // dispatches the bot message there. Adding another dispatch here would
    // post the same summary twice.

    if (openBotSidebar) {
      navigateToBotSidebar();
    }

    return { ok: true, statusCode: 0, stage: "summary_answer", chatBody, rawOutput };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (openBotOnError) {
      postBotErrorAndNavigate(
        dispatch,
        "Script run failed (network or service error)",
        msg,
      );
    }
    return { ok: false, statusCode: -1, stage: "client", error: msg };
  }
}
