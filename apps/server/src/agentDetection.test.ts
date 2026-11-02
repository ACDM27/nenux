import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { defaultAgentRuntime } from "@termany/core";
import { detectAgentExecutable, parseAgentDetectionInput } from "./agentDetection.js";

test("detection accepts absent runtime and preserves OAuth runtime configuration", () => {
  assert.equal(parseAgentDetectionInput({ id: "custom", command: "node" })?.runtime, undefined);
  assert.deepEqual(parseAgentDetectionInput({ id: "oauth", runtime: { protocol: "chatgpt-oauth", model: "test-model" } })?.runtime,
    { protocol: "chatgpt-oauth", model: "test-model" });
});

test("managed Claude and Codex runtimes require their user-installed CLI", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-managed-detect-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const id of ["claude", "codex"] as const) {
    const cli = path.join(directory, id);
    await fs.writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = await detectAgentExecutable({
      id,
      name: id,
      command: cli,
      args: "",
      enabled: true,
      builtIn: true,
      runtime: { protocol: "acp", distribution: "managed", modelSource: "agent", command: `${id}-agent-acp`, args: "" },
    });
    assert.equal(result.installed, true);
    assert.equal(result.terminalInstalled, true);
    assert.equal(result.terminalPath, cli);
    assert.match(result.path ?? "", /acp.*\.m?js$/);
  }
});

test("detection excludes an installed native CLI that lacks ACP", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-agent-detect-"));
  const bin = path.join(directory, "bin");
  await fs.mkdir(bin);
  // The first non-interactive login-shell probe must resolve the fixture too;
  // otherwise a real system `kilo` can win before the .zshrc fallback runs.
  await fs.writeFile(path.join(directory, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
  await fs.writeFile(path.join(directory, ".zshrc"), `export PATH="${bin}:$PATH"\n`);
  await fs.writeFile(path.join(bin, "kilo"), '#!/bin/sh\nprintf "Usage: kilo [prompt]\\n"\n', { mode: 0o755 });
  const shell = process.env.SHELL;
  const zdotdir = process.env.ZDOTDIR;
  process.env.SHELL = "/bin/zsh";
  process.env.ZDOTDIR = directory;
  t.after(async () => {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
    if (zdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = zdotdir;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await detectAgentExecutable({
    id: "kilocode",
    name: "Kilocode",
    command: "kilo",
    args: "",
    enabled: true,
    builtIn: true,
    runtime: defaultAgentRuntime("kilocode"),
  });
  assert.equal(result.installed, false);
  assert.equal(result.terminalInstalled, true);
  assert.equal(result.terminalPath, path.join(bin, "kilo"));
  assert.match(result.error ?? "", /does not support ACP/);
});

test("detection input parsing discards malformed entries and normalizes fields", () => {
  assert.equal(parseAgentDetectionInput(null), undefined);
  assert.equal(parseAgentDetectionInput({ command: "kilo" }), undefined);
  assert.deepEqual(parseAgentDetectionInput({
    id: " kilocode ",
    command: " kilo ",
    runtime: { protocol: "acp", command: " kilo ", args: " acp " },
  }), {
    id: "kilocode",
    name: "kilocode",
    command: "kilo",
    args: "",
    enabled: true,
    builtIn: false,
    runtime: {
      protocol: "acp",
      command: "kilo",
      args: "acp",
      distribution: "system",
      modelSource: "agent",
    },
  });
  assert.deepEqual(parseAgentDetectionInput({
    id: " fastclaw ",
    command: "fastclaw",
    runtime: { protocol: "acp-http", endpoint: " http://127.0.0.1:18953/acp/ ", apiKey: " key " },
  })?.runtime, {
    protocol: "acp-http",
    endpoint: "http://127.0.0.1:18953/acp",
    apiKey: "key",
  });
});

test("FastClaw detection verifies ACP version and API key", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/acp/ping") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", protocol: "acp/0.2" }));
      return;
    }
    if (request.url === "/acp/agents?limit=1" && request.headers.authorization === "Bearer test-key") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ agents: [{ name: "main" }] }));
      return;
    }
    response.writeHead(401).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/acp`;
  const agent = {
    id: "fastclaw", name: "FastClaw", command: "termany-fastclaw-test-missing", args: "", enabled: true, builtIn: true,
    runtime: { protocol: "acp-http" as const, endpoint: base, apiKey: "test-key" },
  };
  assert.deepEqual(await detectAgentExecutable(agent), {
    id: "fastclaw", command: base, installed: true, path: base,
    terminalInstalled: false,
  });
  const denied = await detectAgentExecutable({ ...agent, runtime: { ...agent.runtime, apiKey: "wrong" } });
  assert.equal(denied.installed, false);
  assert.match(denied.error ?? "", /authentication failed \(401\)/);
});
