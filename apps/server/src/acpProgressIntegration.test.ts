import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpRuntimeEvent } from "./acpRuntime.js";

test("ACP reports progress before the reply and stopping during startup never submits a prompt", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-progress-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  const { promptAcpRuntime, closeAllAcpRuntimes } = await import("./acpRuntime.js");
  t.after(async () => { closeAllAcpRuntimes(); db.getDb().close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  db.setAgentsRaw(JSON.stringify([{
    id: "test", name: "Test", command: process.execPath, args: "", enabled: true,
    runtime: { protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
      args: JSON.stringify(fileURLToPath(new URL("../tests/fixtures/group-chat-acp.mjs", import.meta.url))) },
  }]));
  const target = { paneId: "progress", agentId: "test", cwd: directory, prompt: "Hello" };
  const events: AcpRuntimeEvent[] = [];
  const reply = promptAcpRuntime({ ...target, signal: new AbortController().signal, emit: (event) => events.push(event) });
  assert.equal(events[0]?.type, "activity", "feedback arrives before startup finishes");
  assert.equal(events.some((event) => event.type === "delta"), false);
  await reply;
  assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.phase), ["starting", "processing"]);
  assert.ok(events.findIndex((event) => event.type === "delta") > events.findIndex((event) => event.type === "activity" && event.phase === "processing"));

  const cancelled: AcpRuntimeEvent[] = [];
  const abort = new AbortController();
  await assert.rejects(promptAcpRuntime({ ...target, paneId: "cancelled", signal: abort.signal, emit: (event) => {
    cancelled.push(event);
    if (event.type === "activity" && event.phase === "starting") abort.abort();
  } }), { name: "AbortError" });
  assert.deepEqual(cancelled.map((event) => event.type), ["activity"]);
  let text = "";
  await promptAcpRuntime({ ...target, paneId: "cancelled", signal: new AbortController().signal,
    emit: (event) => { if (event.type === "delta") text += event.text; } });
  assert.equal(JSON.parse(text).promptCount, 1, "the cancelled message never reached the model");
});
