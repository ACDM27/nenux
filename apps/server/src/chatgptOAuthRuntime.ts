import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { AcpRuntimeEvent } from "./acpRuntime.js";
import type { AgentConfig } from "./agentConfig.js";
import type { LoadedAgentImage } from "./agentImages.js";
import { botAcpPrompt } from "./botIdentity.js";
import { getValidCredentials, type ChatGPTCredentials } from "./chatgptOAuth.js";
import { loadCredentials } from "./chatgptCredentialStore.js";
import { CODEX_MODELS, type CodexModel, type CodexMessage, streamCodexResponse } from "./chatgptCodexProvider.js";

type Emit = (event: AcpRuntimeEvent) => void;
const defaultDependencies = { loadCredentials, getValidCredentials, streamCodexResponse };
type RuntimeDependencies = typeof defaultDependencies;

/**
 * ChatGPT OAuth Runtime - uses ChatGPT Plus/Pro subscription via OAuth.
 * This runtime doesn't need a local CLI, it calls the ChatGPT Codex API directly.
 */
export class ChatGPTOAuthRuntime {
  private prompting = false;
  private sessionId: string = randomUUID();
  private configOptions: SessionConfigOption[] = [];
  private history: CodexMessage[] = [];
  private request?: AbortController;
  private closed = false;

  private constructor(
    readonly paneId: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    private credentials: ChatGPTCredentials,
    private model: CodexModel,
    private dependencies: RuntimeDependencies
  ) {
    // Build config options for model selection
    this.configOptions = [
      {
        id: "model",
        label: "Model",
        type: "select",
        currentValue: model,
        options: CODEX_MODELS.map((m) => ({
          value: m.id,
          label: m.name,
          description: `${(m.contextWindow / 1000).toFixed(0)}K context`,
        })),
      },
    ];
  }

  static async create(paneId: string, agent: AgentConfig, cwd: string, dependencies: RuntimeDependencies = defaultDependencies): Promise<ChatGPTOAuthRuntime> {
    const spec = agent.runtime;
    if (!spec || spec.protocol !== "chatgpt-oauth") {
      throw new Error(`${agent.name} has no ChatGPT OAuth runtime configured`);
    }

    // Load and validate ChatGPT credentials
    const stored = dependencies.loadCredentials();
    if (!stored) {
      throw new Error("ChatGPT login required. Please login first.");
    }

    const credentials = await dependencies.getValidCredentials(stored);
    if (!credentials) {
      throw new Error("ChatGPT login expired. Please login again.");
    }

    const model = (spec.model as CodexModel) || "gpt-5.6-sol";

    return new ChatGPTOAuthRuntime(paneId, agent, cwd, credentials, model, dependencies);
  }

  get config(): SessionConfigOption[] {
    return this.configOptions;
  }

  async applyConfig(picks: Record<string, string>): Promise<void> {
    if (picks.model) {
      this.model = picks.model as CodexModel;
      const option = this.configOptions.find((o) => o.id === "model");
      if (option && option.type === "select") {
        option.currentValue = this.model;
      }
    }
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    if (configId === "model") {
      this.model = value as CodexModel;
      const option = this.configOptions.find((o) => o.id === "model");
      if (option && option.type === "select") {
        option.currentValue = this.model;
      }
    }
    return this.configOptions;
  }

  async prompt(text: string, emit: Emit, signal: AbortSignal, botIdentity?: unknown, images: LoadedAgentImage[] = []): Promise<void> {
    if (this.closed) throw new Error("Agent conversation is closed");
    signal.throwIfAborted();
    if (this.prompting) throw new Error("This agent is already responding");
    this.prompting = true;
    const controller = new AbortController();
    this.request = controller;
    signal = AbortSignal.any([signal, controller.signal]);

    try {
      // Refresh credentials if needed
      const credentials = await this.dependencies.getValidCredentials(this.credentials);
      if (!credentials) {
        throw new Error("ChatGPT login expired. Please login again.");
      }
      this.credentials = credentials;

      // Build prompt with bot identity
      const base = botAcpPrompt(text, botIdentity);
      const promptText = typeof base === "string" ? base : base.map((block) => block.text).join("\n\n");

      emit({ type: "activity", title: this.agent.name, status: "Thinking", phase: "processing" });

      // Call ChatGPT Codex API
      const messages: CodexMessage[] = [...this.history, { role: "user", content: promptText, images: images.map(image => ({ mimeType: image.mimeType, data: image.data })) }];
      while (messages.length > 1 && (messages.length > 40 || JSON.stringify(messages).length > 500_000)) messages.shift();

      // Build instructions with model identity
      const modelName = CODEX_MODELS.find(m => m.id === this.model)?.name || this.model;
      const instructions = `You are ${modelName}, a large language model trained by OpenAI. You are running inside Termany, a multi-agent terminal application. When asked about your identity or model, you can tell the user that you are ${modelName}.`;

      let output = "";
      for await (const chunk of this.dependencies.streamCodexResponse(this.credentials, this.model, messages, { signal, instructions })) {
        signal.throwIfAborted();

        if (chunk.type === "text") {
          output += chunk.text || "";
          emit({ type: "delta", text: chunk.text || "" });
        } else if (chunk.type === "tool_call" && chunk.toolCall) {
          throw new Error("This OAuth runtime cannot execute local tool calls; select a CLI/ACP runtime for file operations");
        } else if (chunk.type === "error") {
          throw new Error(chunk.error || "ChatGPT model request failed");
        }
      }

      signal.throwIfAborted();
      if (!output.trim()) throw new Error("ChatGPT returned no content");
      this.history = [...messages, { role: "assistant", content: output }];
      emit({ type: "done", sessionId: this.sessionId });
    } finally {
      this.prompting = false;
      if (this.request === controller) this.request = undefined;
    }
  }

  respondPermission(_requestId: string, _optionId: string): boolean {
    // ChatGPT OAuth doesn't have permission system like ACP
    return false;
  }

  close(): void {
    this.closed = true;
    this.request?.abort(new Error("Agent conversation was closed"));
    this.history = [];
  }
}
