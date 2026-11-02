import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_RUNTIME_REVISION, defaultAgentRuntime } from "@termany/core";

test("registry upgrades add native runtimes without overwriting opt-outs or custom adapters", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-registry-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  t.after(async () => { db.getDb().close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const { listAgentConfigs, saveAgentConfigs } = await import("./agentConfig.js");
  const defaults = listAgentConfigs().agents;
  const commands = { gemini: ["gemini", "--acp"], grok: ["grok", "agent stdio"], kimi: ["kimi", "acp"], cursor: ["cursor-agent", "acp"] };
  for (const [id, [command, args]] of Object.entries(commands)) {
    const runtime = defaults.find((agent) => agent.id === id)?.runtime;
    assert.equal(runtime?.protocol, "acp");
    if (runtime?.protocol !== "acp") continue;
    assert.equal(runtime.command, command);
    assert.equal(runtime.args, args);
  }
  assert.deepEqual(defaults.find((agent) => agent.id === "fastclaw")?.runtime, defaultAgentRuntime("fastclaw"));
  for (const id of ["claude", "codex"]) {
    const runtime = defaults.find((agent) => agent.id === id)?.runtime;
    assert.deepEqual(runtime, defaultAgentRuntime(id));
    if (id === "claude" && runtime?.protocol === "acp") assert.equal(runtime.distribution, "managed");
  }
  const oauth = saveAgentConfigs(defaults.map(agent => agent.id === "codex" ? { ...agent, runtime: { protocol: "chatgpt-oauth", model: "chosen-model" } } : agent));
  assert.deepEqual(oauth.find(agent => agent.id === "codex")?.runtime, { protocol: "chatgpt-oauth", model: "chosen-model" });
  assert.equal(defaults.some((agent) => agent.id === "kilocode" || agent.id === "droid"), false);
  assert.equal(defaults.findIndex((agent) => agent.id === "grok"), defaults.findIndex((agent) => agent.id === "gemini") + 1);
  const legacyFastClaw = defaults.map((agent) => agent.id === "fastclaw" ? {
    ...agent,
    runtime: { protocol: "acp", command: "fastclaw", args: "acp", distribution: "system", modelSource: "agent" },
    // A previous sanitize pass could stamp the latest global revision while
    // retaining this obsolete non-null preset, so signature matching must win.
    runtimeRevision: AGENT_RUNTIME_REVISION,
  } : agent);
  db.setAgentsRaw(JSON.stringify(legacyFastClaw));
  assert.deepEqual(
    listAgentConfigs().agents.find((agent) => agent.id === "fastclaw")?.runtime,
    defaultAgentRuntime("fastclaw")
  );
  const customFastClaw = legacyFastClaw.map((agent) => agent.id === "fastclaw" ? {
    ...agent,
    runtime: { ...agent.runtime, command: "/custom/fastclaw-acp", distribution: "custom" },
  } : agent);
  db.setAgentsRaw(JSON.stringify(customFastClaw));
  assert.deepEqual(
    listAgentConfigs().agents.find((agent) => agent.id === "fastclaw")?.runtime,
    customFastClaw.find((agent) => agent.id === "fastclaw")?.runtime
  );
  const legacyNpx = defaults.map((agent) => {
    if (agent.id !== "claude" && agent.id !== "codex") return agent;
    const packageName = agent.id === "claude"
      ? "@agentclientprotocol/claude-agent-acp"
      : "@agentclientprotocol/codex-acp";
    return {
      ...agent,
      runtime: {
        protocol: "acp",
        command: "npx",
        args: `-y ${packageName}`,
        distribution: "system",
        modelSource: "agent",
      },
      runtimeRevision: AGENT_RUNTIME_REVISION,
    };
  });
  db.setAgentsRaw(JSON.stringify(legacyNpx));
  for (const id of ["claude", "codex"]) {
    assert.deepEqual(listAgentConfigs().agents.find((agent) => agent.id === id)?.runtime, defaultAgentRuntime(id));
  }
  const customLegacyNpx = legacyNpx.map((agent) => agent.id === "claude" ? {
    ...agent,
    runtime: { ...agent.runtime, distribution: "custom" },
  } : agent);
  db.setAgentsRaw(JSON.stringify(customLegacyNpx));
  assert.deepEqual(
    listAgentConfigs().agents.find((agent) => agent.id === "claude")?.runtime,
    customLegacyNpx.find((agent) => agent.id === "claude")?.runtime,
    "an explicitly custom npx bridge remains user-owned"
  );
  const custom = { ...defaultAgentRuntime("gemini")!, command: "/custom/adapter", args: "--custom", distribution: "custom" };
  const previous = defaults.map((agent) => ({ ...agent, enabled: true, runtime: null, runtimeRevision: 1 }));
  db.setAgentsRaw(JSON.stringify(previous));
  const migrated = listAgentConfigs().agents;
  for (const id of Object.keys(commands)) {
    assert.deepEqual(migrated.find((agent) => agent.id === id)?.runtime, defaultAgentRuntime(id));
  }
  assert.deepEqual(migrated.find((agent) => agent.id === "fastclaw")?.runtime, defaultAgentRuntime("fastclaw"));
  for (const id of ["claude", "codex", "opencode"]) {
    assert.equal(migrated.find((agent) => agent.id === id)?.runtime, null, "existing explicit opt-outs survive the revision bump");
  }
  assert.deepEqual(migrated.map((agent) => agent.id), defaults.map((agent) => agent.id));
  assert.ok(migrated.every((agent) => agent.enabled));

  const saved = saveAgentConfigs(previous.map((agent) => agent.id === "gemini" ? { ...agent, runtime: custom } : agent));
  assert.deepEqual(saved.find((agent) => agent.id === "gemini")?.runtime, custom);
  const disabled = saveAgentConfigs(saved.map((agent) => ({ ...agent, runtime: null, runtimeRevision: AGENT_RUNTIME_REVISION })));
  assert.ok(disabled.every((agent) => agent.runtime === null));
  assert.ok(listAgentConfigs().agents.every((agent) => agent.runtime === null));

  db.setAgentsRaw(JSON.stringify([{ id: "kimi", name: "My Kimi", command: "kimi", enabled: false, runtime: null }]));
  const legacy = listAgentConfigs().agents.find((agent) => agent.id === "kimi")!;
  assert.deepEqual(legacy.runtime, defaultAgentRuntime("kimi"));
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.name, "My Kimi");

  db.setAgentsRaw(JSON.stringify([
    { id: "droid", name: "Droid", command: "droid", enabled: true },
    { id: "grok", name: "Grok Build", command: "grok", enabled: true },
    { id: "gemini", name: "Gemini", command: "gemini", enabled: true },
    { id: "kilocode", name: "Kilocode", command: "kilo", enabled: true },
  ]));
  const cleaned = listAgentConfigs().agents;
  assert.equal(cleaned.some((agent) => agent.id === "kilocode" || agent.id === "droid"), false);
  const migratedGrok = cleaned.find((agent) => agent.id === "grok");
  assert.equal(migratedGrok?.builtIn, true, "a Grok entry saved by an older release becomes the built-in preset");
  assert.deepEqual(migratedGrok?.runtime, defaultAgentRuntime("grok"));
  assert.equal(cleaned.findIndex((agent) => agent.id === "grok"), cleaned.findIndex((agent) => agent.id === "gemini") + 1);

  const generatedId = "685e85a1-c5a3-43df-b152-c0a7fe103a44";
  const customWithPlaceholder = saveAgentConfigs([{
    id: generatedId,
    name: "Custom Agent",
    command: generatedId,
    args: "",
    enabled: true,
    builtIn: false,
    runtime: {
      protocol: "acp",
      command: generatedId,
      args: "acp",
      distribution: "system",
      modelSource: "agent",
    },
  }]).find((agent) => agent.id === generatedId);
  assert.equal(customWithPlaceholder?.command, "");
  assert.equal(customWithPlaceholder?.runtime, undefined);

  const namedCommand = saveAgentConfigs([{
    id: "my-agent",
    name: "My Agent",
    command: "my-agent",
    args: "",
    enabled: true,
    builtIn: false,
  }]).find((agent) => agent.id === "my-agent");
  assert.equal(namedCommand?.command, "my-agent", "non-generated ids remain valid commands");
});
