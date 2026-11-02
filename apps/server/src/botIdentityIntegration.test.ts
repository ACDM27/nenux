import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Bot identity reaches both provider formats and a reused ACP session", { timeout: 30_000 }, async (t) => {
  // db.ts initializes at import time. Redirect its directory before loading it
  // so this test never opens or changes the user's model/agent configuration.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-bot-identity-"));
  const homeMock = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  homeMock.mock.restore();
  const { streamAgentChat } = await import("./agentChat.js");
  const { promptAcpRuntime, closeAcpRuntimes } = await import("./acpRuntime.js");
  t.after(() => {
    closeAcpRuntimes(["identity-pane"]);
    db.getDb().close();
    return fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const messages = [{ role: "user" as const, content: "Who are you?" }];
  for (const kind of ["openai", "anthropic"] as const) {
    await t.test(`${kind} receives current Bot metadata in its system prompt`, async (t) => {
      db.setModelsRaw(JSON.stringify({ providers: [{
        id: "test", kind, name: "Test provider", apiBase: "https://model.invalid",
        apiKey: "test-key", models: ["test-model"],
      }], defaultModel: "test/test-model" }));
      const requests: Record<string, any>[] = [];
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        const event = kind === "anthropic"
          ? { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
          : { choices: [{ delta: { content: "hello" } }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
      });
      let reply = "";
      await streamAgentChat(undefined, messages, new AbortController().signal, (text) => { reply += text; }, {
        name: "Research bot", description: "Research markets",
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {}, {
        name: "Writing bot", description: "",
      });
      await streamAgentChat(undefined, messages, new AbortController().signal, () => {});
      const imagePath = path.join(directory, `${kind}.png`);
      await fs.writeFile(imagePath, Buffer.from(`${kind} image`));
      await streamAgentChat(undefined, [{ role: "user", content: "Describe this", images: [{ path: imagePath }] }],
        new AbortController().signal, () => {});
      assert.equal(reply, "hello");
      const systems = requests.map((request) => kind === "anthropic" ? request.system : request.messages[0].content);
      assert.match(systems[0], /Research bot/);
      assert.match(systems[0], /Research markets/);
      assert.match(systems[0], /no tool access/);
      assert.match(systems[1], /Writing bot/);
      assert.ok(systems[1].includes('"description":""'));
      assert.doesNotMatch(systems[1], /Research bot|Research markets/);
      assert.doesNotMatch(systems[2], /Current Bot profile/);
      for (const request of requests.slice(0, 3)) {
        assert.equal(request.model, "test-model");
        assert.deepEqual(kind === "anthropic" ? request.messages : request.messages.slice(1), messages);
      }
      const imageContent = kind === "anthropic" ? requests[3].messages[0].content : requests[3].messages[1].content;
      assert.equal(imageContent[0].type, kind === "anthropic" ? "image" : "text");
      const imageBlock = imageContent.find((item: { type: string }) => item.type === (kind === "anthropic" ? "image" : "image_url"));
      assert.ok(imageBlock);
      if (kind === "anthropic") {
        assert.equal(imageBlock.source.media_type, "image/png");
        assert.equal(imageBlock.source.data, Buffer.from(`${kind} image`).toString("base64"));
      } else {
        assert.equal(imageBlock.image_url.url, `data:image/png;base64,${Buffer.from(`${kind} image`).toString("base64")}`);
      }
    });
  }

  await t.test("ACP keeps one session while applying renames and cleared descriptions", async () => {
    db.setAgentsRaw(JSON.stringify([{
      id: "identity-test-agent", name: "Test agent", command: process.execPath, args: "", enabled: true,
      runtime: {
        protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
        args: JSON.stringify(fileURLToPath(new URL("../tests/fixtures/bot-identity-acp.mjs", import.meta.url))),
      },
    }]));
    const turn = async (botIdentity?: { name: string; description?: string }, images?: { path: string }[]) => {
      let reply = "";
      await promptAcpRuntime({
        paneId: "identity-pane", agentId: "identity-test-agent", cwd: directory,
        prompt: "Who are you?", images, botIdentity, signal: new AbortController().signal,
        emit: (event) => { if (event.type === "delta") reply += event.text; },
      });
      return JSON.parse(reply) as { prompt: { type: string; text?: string; data?: string; mimeType?: string }[]; pid: number };
    };
    const first = await turn({ name: "Research bot", description: "Research markets" });
    const renamed = await turn({ name: "Writing bot", description: "" });
    assert.equal(first.pid, renamed.pid, "editing a Bot must not restart its conversation");
    assert.match(first.prompt[0].text, /Research bot/);
    assert.match(first.prompt[0].text, /Research markets/);
    assert.match(renamed.prompt[0].text, /Writing bot/);
    assert.ok(renamed.prompt[0].text.includes('"description":""'));
    assert.deepEqual(renamed.prompt[1], { type: "text", text: "Who are you?" });
    assert.doesNotMatch(renamed.prompt[0].text, /Research bot|Research markets/);
    const plain = await turn();
    assert.deepEqual(plain.prompt, [{ type: "text", text: "Who are you?" }]);
    const imagePath = path.join(directory, "pasted.png");
    await fs.writeFile(imagePath, Buffer.from("image bytes"));
    const pictured = await turn(undefined, [{ path: imagePath }]);
    assert.deepEqual(pictured.prompt[0], { type: "text", text: "Who are you?" });
    assert.equal(pictured.prompt[1].type, "image");
    assert.equal(pictured.prompt[1].mimeType, "image/png");
    assert.equal(pictured.prompt[1].data, Buffer.from("image bytes").toString("base64"));
  });
});
