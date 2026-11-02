import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpRuntimeEvent } from "./acpRuntime.js";

test("native bots support model selection, continuous turns, permissions and cancellation", { timeout: 30_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-native-acp-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  const runtime = await import("./acpRuntime.js");
  t.after(async () => { runtime.closeAllAcpRuntimes(); db.getDb().close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const fixture = fileURLToPath(new URL("../tests/fixtures/native-acp.mjs", import.meta.url));
  db.setAgentsRaw(JSON.stringify(["gemini", "kimi", "kilocode", "cursor", "image", "corrupt", "exit", "child"].map((id) => ({
    // Terminal launch and native conversation support are independent: Kimi's
    // ACP runtime must remain available while its CLI/TUI launcher is off.
    id, name: id, command: process.execPath, args: "", enabled: id !== "kimi",
    runtime: { protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
      args: `${JSON.stringify(fixture)} ${id === "gemini" ? "legacy" : id}` },
  }))));
  for (const id of ["gemini", "kimi", "kilocode", "cursor"]) {
    await t.test(id, async () => {
      const target = { paneId: id, agentId: id, cwd: directory };
      const options = await runtime.loadAcpRuntimeConfig(target);
      assert.equal(options.find((option) => option.category === "model")?.currentValue, "default");
      assert.equal(options.find((option) => option.category === "mode")?.currentValue, "ask");
      await runtime.setAcpConfigOption({ ...target, configId: "model", value: "other" });
      await runtime.setAcpConfigOption({ ...target, configId: "mode", value: "code" });
      await assert.rejects(runtime.setAcpConfigOption({ ...target, configId: "model", value: "not-offered" }), /Invalid value/);
      const sessions: string[] = [];
      for (const turn of [1, 2]) {
        const events: AcpRuntimeEvent[] = [];
        await runtime.promptAcpRuntime({ ...target, prompt: "Hello", botIdentity: { name: "My bot", description: "Help me" }, signal: new AbortController().signal,
          emit: (event) => {
            events.push(event);
            if (event.type === "permission") {
              assert.equal(runtime.respondAcpPermission(id, event.requestId, "invalid"), false);
              assert.equal(runtime.respondAcpPermission(id, event.requestId, turn === 1 ? "allow" : "reject"), true);
            }
          },
        });
        const reply = JSON.parse(events.filter((event) => event.type === "delta").map((event) => event.text).join(""));
        assert.equal(reply.turns, turn);
        assert.equal(reply.model, "other");
        assert.equal(reply.mode, "code");
        assert.equal(reply.permission.optionId, turn === 1 ? "allow" : "reject");
        assert.ok(JSON.stringify(reply.prompt).includes("My bot"));
        const toolEvents = events.filter((event) => event.type === "tool" && event.id === "read");
        assert.equal(toolEvents[0]?.status, "pending");
        assert.equal(toolEvents.at(-1)?.status, "completed");
        sessions.push(events.find((event) => event.type === "done")!.sessionId);
      }
      assert.equal(sessions[0], sessions[1]);
      const abort = new AbortController();
      await runtime.promptAcpRuntime({ ...target, prompt: "Cancel", signal: abort.signal,
        emit: (event) => { if (event.type === "permission") abort.abort(); },
      });
      runtime.closeAcpRuntimes([id]);
      const restarted = await runtime.loadAcpRuntimeConfig({ ...target, config: { model: "other", mode: "code" } });
      assert.equal(restarted.find((option) => option.category === "model")?.currentValue, "other");
      assert.equal(restarted.find((option) => option.category === "mode")?.currentValue, "code");
    });
  }
  const imageEvents: AcpRuntimeEvent[] = [];
  const imageDirectory = path.join(directory, "agent-images");
  const previousImageDirectory = process.env.TERMANY_AGENT_IMAGE_DIR;
  process.env.TERMANY_AGENT_IMAGE_DIR = imageDirectory;
  try {
    await runtime.promptAcpRuntime({ paneId: "image", agentId: "image", cwd: directory, prompt: "Image",
      signal: new AbortController().signal, emit: (event) => imageEvents.push(event) });
  } finally {
    if (previousImageDirectory === undefined) delete process.env.TERMANY_AGENT_IMAGE_DIR;
    else process.env.TERMANY_AGENT_IMAGE_DIR = previousImageDirectory;
  }
  const generated = imageEvents.find((event) => event.type === "image");
  assert.ok(generated && generated.type === "image");
  assert.equal(generated.mimeType, "image/png");
  assert.deepEqual(await fs.readFile(generated.path), Buffer.from("generated image bytes"));
  assert.ok(imageEvents.some((event) => event.type === "tool"));
  assert.ok(imageEvents.some((event) => event.type === "delta"));
  const repairedEvents: AcpRuntimeEvent[] = [];
  await runtime.promptAcpRuntime({ paneId: "corrupt", agentId: "corrupt", cwd: directory, prompt: "能力",
    signal: new AbortController().signal, emit: (event) => repairedEvents.push(event) });
  assert.equal(repairedEvents.find((event) => event.type === "delta")?.text, "我���备网页浏览能力。");
  assert.equal(repairedEvents.find((event) => event.type === "replace")?.text, "我具备网页浏览能力。");
  assert.ok(repairedEvents.findIndex((event) => event.type === "replace") < repairedEvents.findIndex((event) => event.type === "done"));
  await assert.rejects(runtime.loadAcpRuntimeConfig({ paneId: "exit", agentId: "exit", cwd: directory }), /missing dependency/);
  if (process.platform !== "win32") {
    await runtime.loadAcpRuntimeConfig({ paneId: "child", agentId: "child", cwd: directory });
    const pid = Number(await fs.readFile(path.join(directory, "native-child.pid"), "utf8"));
    t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ } });
    runtime.closeAcpRuntimes(["child"]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 3_000;
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(), false, "closing the runtime also stops the CLI's child process");
  }
});
