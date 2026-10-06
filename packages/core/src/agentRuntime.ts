export type AgentRuntimeConfig = {
  protocol: "acp";
  command: string;
  args: string;
  distribution: "managed" | "system" | "custom";
  modelSource: "termany" | "agent";
} | {
  /** BeeAI Agent Communication Protocol 0.2 over HTTP/SSE. */
  protocol: "acp-http";
  endpoint: string;
  apiKey: string;
} | {
  /** ChatGPT OAuth - uses ChatGPT Plus/Pro subscription via OAuth. */
  protocol: "chatgpt-oauth";
  model: string;
};

export const AGENT_RUNTIME_REVISION = 6;

// The introduction revision is per agent: adding a new adapter must not
// re-enable an older adapter that the user explicitly turned off.
type RuntimePreset = (AgentRuntimeConfig & { revision: number });
const stdio = (command: string, args: string, revision: number): RuntimePreset => ({
  protocol: "acp", command, args, revision, distribution: "system", modelSource: "agent",
});
const managed = (command: string, revision: number): RuntimePreset => ({
  protocol: "acp", command, args: "", revision, distribution: "managed", modelSource: "agent",
});

const BUILTIN_RUNTIMES: Record<string, RuntimePreset> = {
  // Termany ships these small ACP bridges and points them at the user's CLI.
  // This avoids requiring system Node/npx or downloading a second agent binary.
  claude: managed("claude-agent-acp", 1),
  // Codex uses ChatGPT OAuth - no local CLI needed, uses ChatGPT Plus/Pro subscription
  codex: { protocol: "chatgpt-oauth", model: "gpt-5.6-sol", revision: 7 },
  opencode: stdio("opencode", "acp", 1),
  gemini: stdio("gemini", "--acp", 2),
  kimi: stdio("kimi", "acp", 2),
  kilocode: stdio("kilo", "acp", 2),
  // Use Cursor's unambiguous executable; `agent` can belong to another app.
  cursor: stdio("cursor-agent", "acp", 2),
  openclaw: stdio("openclaw", "acp", 3),
  hermes: stdio("hermes", "acp", 3),
  omp: stdio("omp", "acp", 3),
  // Droid exposes ACP through its headless exec mode, not a bare subcommand.
  droid: stdio("droid", "exec --output-format acp-daemon", 3),
  fastclaw: {
    protocol: "acp-http", endpoint: "http://127.0.0.1:18953/acp", apiKey: "", revision: 4,
  },
  grok: stdio("grok", "agent stdio", 5),
};

export function defaultAgentRuntime(id: string): AgentRuntimeConfig | undefined {
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_RUNTIMES, id)) return undefined;
  const preset = BUILTIN_RUNTIMES[id];
  if (!preset) return undefined;
  const { revision: _revision, ...runtime } = preset;
  return runtime;
}

export function inheritsDefaultAgentRuntime(input: {
  id: string;
  runtime?: unknown;
  runtimeRevision?: number;
}): boolean {
  if (!Object.prototype.hasOwnProperty.call(input, "runtime")) return true;
  // Older releases launched these bridges through system npx. Move only the
  // exact built-in presets to the packaged bridge; custom adapters stay put.
  if (isLegacyNpxRuntime(input.id, input.runtime)) return true;
  // FastClaw originally shipped as a stdio Agent Client Protocol preset. The
  // CLI now exposes BeeAI Agent Communication Protocol 0.2 through its HTTP
  // gateway instead, so the old built-in command can never work. Match only
  // that exact system preset: custom commands and explicit opt-outs remain
  // user-owned even after the built-in default changes.
  if (isLegacyFastClawRuntime(input.id, input.runtime)) return true;
  if (input.runtime != null) return false;
  const introduced = BUILTIN_RUNTIMES[input.id]?.revision;
  if (!introduced) return false;
  const revision = Number(input.runtimeRevision);
  return !Number.isFinite(revision) || revision < introduced;
}

function isLegacyNpxRuntime(id: string, raw: unknown): boolean {
  const packages: Record<string, string> = {
    claude: "@agentclientprotocol/claude-agent-acp",
    codex: "@agentclientprotocol/codex-acp",
  };
  const packageName = packages[id];
  if (!packageName || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const runtime = raw as Record<string, unknown>;
  return runtime.protocol === "acp" &&
    String(runtime.command ?? "").trim() === "npx" &&
    String(runtime.args ?? "").trim() === `-y ${packageName}` &&
    (runtime.distribution === undefined || runtime.distribution === "system") &&
    (runtime.modelSource === undefined || runtime.modelSource === "agent");
}

function isLegacyFastClawRuntime(id: string, raw: unknown): boolean {
  if (id !== "fastclaw" || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const runtime = raw as Record<string, unknown>;
  const distribution = runtime.distribution;
  const modelSource = runtime.modelSource;
  return runtime.protocol === "acp" &&
    String(runtime.command ?? "").trim() === "fastclaw" &&
    String(runtime.args ?? "").trim() === "acp" &&
    (distribution === undefined || distribution === "system") &&
    (modelSource === undefined || modelSource === "agent");
}
