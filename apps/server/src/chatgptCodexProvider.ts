/**
 * ChatGPT Codex Provider - Calls the Codex Responses API using OAuth tokens.
 *
 * This provider uses the ChatGPT Responses API endpoint to access Codex
 * functionality without requiring an OpenAI API key.
 */
import crypto from "node:crypto";
import type { ChatGPTCredentials } from "./chatgptOAuth.js";

const CODEX_API_BASE = "https://chatgpt.com/backend-api";

// Available Codex models for ChatGPT Plus accounts (from TabTin)
// Note: gpt-5.4 and gpt-5.4-mini are NOT supported for Plus accounts
export const CODEX_MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1_050_000, maxOutput: 128_000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 1_050_000, maxOutput: 128_000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1_050_000, maxOutput: 128_000 },
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 1_050_000, maxOutput: 128_000 },
] as const;

export type CodexModel = typeof CODEX_MODELS[number]["id"];

export interface CodexMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
}

export interface CodexToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CodexStreamChunk {
  type: "text" | "tool_call" | "done" | "error";
  text?: string;
  toolCall?: CodexToolCall;
  error?: string;
}

/**
 * Call the Codex Responses API with streaming support.
 */
export async function* streamCodexResponse(
  credentials: ChatGPTCredentials,
  model: CodexModel,
  messages: CodexMessage[],
  options: {
    tools?: Array<{
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
    reasoningEffort?: "none" | "low" | "medium" | "high";
    signal?: AbortSignal;
    instructions?: string;
  } = {}
): AsyncGenerator<CodexStreamChunk> {
  const { tools, reasoningEffort = "medium", signal, instructions } = options;

  // Build request body (following TabTin's format)
  const body: Record<string, unknown> = {
    model,
    store: false, // Codex requires store=false
    stream: true, // Codex REQUIRES stream=true
    input: messages.map((msg) => ({
      role: msg.role === "system" ? "developer" : msg.role,
      content: [{ type: "input_text", text: msg.content }],
    })),
    instructions: instructions || "You are a helpful AI assistant.",
    parallel_tool_calls: true,
    reasoning: { effort: reasoningEffort },
    service_tier: "priority", // TabTin uses 'priority'
  };

  // Only add optional fields if needed
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    body.tool_choice = "auto";
  }

  // Generate unique IDs for this request
  const sessionId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  // Make API request
  const response = await fetch(`${CODEX_API_BASE}/codex/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "termany",
      "session-id": sessionId,
      "x-client-request-id": requestId,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Codex API error: ${response.status}`;

    console.error(`[ChatGPT Codex] API error ${response.status}:`, errorText);

    if (response.status === 401) {
      errorMessage = "ChatGPT 登录已失效，请重新登录";
    } else if (response.status === 429) {
      // Parse usage limit error
      try {
        const error = JSON.parse(errorText);
        if (error.error?.type === "usage_limit_reached") {
          const resetsInSeconds = error.error.resets_in_seconds || 0;
          const minutes = Math.ceil(resetsInSeconds / 60);
          errorMessage = `ChatGPT Plus 使用限制已达上限，请在 ${minutes} 分钟后重试`;
        } else {
          errorMessage = "请求频率过高，请稍后再试";
        }
      } catch {
        errorMessage = "请求频率过高，请稍后再试";
      }
    } else if (response.status === 402) {
      errorMessage = "Codex 额度已用尽";
    } else {
      try {
        const error = JSON.parse(errorText);
        errorMessage = error.error?.message || error.detail || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }
    }

    yield { type: "error", error: errorMessage };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: "No response body" };
    return;
  }

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();

          if (data === "[DONE]") {
            yield { type: "done" };
            return;
          }

          try {
            const event = JSON.parse(data);
            const chunk = parseSSEEvent(event);
            if (chunk) yield chunk;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE event into a stream chunk.
 */
function parseSSEEvent(event: any): CodexStreamChunk | null {
  const eventType = event.type;

  // Text delta
  if (eventType === "response.output_text.delta") {
    return { type: "text", text: event.delta || "" };
  }

  // Tool call completed
  if (eventType === "response.function_call_arguments.done") {
    return {
      type: "tool_call",
      toolCall: {
        id: event.call_id || event.item?.call_id || "",
        name: event.name || event.item?.name || "",
        arguments: event.arguments || event.item?.arguments || "{}",
      },
    };
  }

  // Response completed
  if (eventType === "response.completed") {
    return { type: "done" };
  }

  // Error
  if (eventType === "response.failed" || eventType === "error") {
    return {
      type: "error",
      error: event.error?.message || event.message || "Unknown error",
    };
  }

  // Incomplete (token limit reached)
  if (eventType === "response.incomplete") {
    return {
      type: "error",
      error: "响应不完整：已达到 token 限制",
    };
  }

  return null;
}

/**
 * Non-streaming version for simple requests.
 */
export async function callCodex(
  credentials: ChatGPTCredentials,
  model: CodexModel,
  messages: CodexMessage[]
): Promise<{ text: string; toolCalls: CodexToolCall[] }> {
  let text = "";
  const toolCalls: CodexToolCall[] = [];

  for await (const chunk of streamCodexResponse(credentials, model, messages)) {
    if (chunk.type === "text") {
      text += chunk.text;
    } else if (chunk.type === "tool_call" && chunk.toolCall) {
      toolCalls.push(chunk.toolCall);
    } else if (chunk.type === "error") {
      throw new Error(chunk.error);
    }
  }

  return { text, toolCalls };
}

/**
 * Test if credentials are valid by making a simple request.
 */
export async function testCodexConnection(
  credentials: ChatGPTCredentials
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${CODEX_API_BASE}/codex/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
        "OpenAI-Beta": "responses=experimental",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        store: false,
        stream: false,
        input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
        instructions: "",
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    const errorText = await response.text();
    let errorMessage = `HTTP ${response.status}`;

    if (response.status === 401) {
      errorMessage = "登录已失效";
    } else if (response.status === 402 || response.status === 429) {
      errorMessage = "额度已用尽";
    } else {
      try {
        const error = JSON.parse(errorText);
        errorMessage = error.error?.message || errorMessage;
      } catch {
        // ignore
      }
    }

    return { ok: false, error: errorMessage };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
