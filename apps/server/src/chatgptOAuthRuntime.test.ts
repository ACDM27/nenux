import assert from "node:assert/strict";
import test from "node:test";
import { ChatGPTOAuthRuntime } from "./chatgptOAuthRuntime.js";
import { streamCodexResponse, type CodexMessage } from "./chatgptCodexProvider.js";
import type { AgentConfig } from "./agentConfig.js";

const credentials = { accessToken: "fixture-token", refreshToken: "fixture-refresh", accountId: "fixture-account", expiresAt: Date.now() + 3_600_000 };
const agent: AgentConfig = { id: "fixture", name: "Fixture", command: "", args: "", enabled: true, builtIn: false,
  runtime: { protocol: "chatgpt-oauth", model: "gpt-5.6-sol" } };

test("OAuth conversations preserve prior turns and do not label model errors as completed", async () => {
  const requests: CodexMessage[][] = [];
  const runtime = await ChatGPTOAuthRuntime.create("test", agent, ".", {
    loadCredentials: () => credentials, getValidCredentials: async value => value,
    streamCodexResponse: async function* (_credentials, _model, messages) {
      requests.push(structuredClone(messages));
      if (requests.length === 3) { yield { type: "error", error: "quota exhausted" }; return; }
      yield { type: "text", text: `reply ${requests.length}` };
      yield { type: "done" };
    },
  });
  await runtime.prompt("first", () => {}, new AbortController().signal);
  await runtime.prompt("second", () => {}, new AbortController().signal);
  assert.equal(requests[1].length, 3);
  assert.equal(requests[1][1].content, "reply 1");
  const events: string[] = [];
  await assert.rejects(runtime.prompt("third", event => { events.push(event.type); }, new AbortController().signal), /quota exhausted/);
  assert.equal(events.includes("done"), false);
  runtime.close();
});

test("closing an OAuth conversation aborts its in-flight request", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runtime = await ChatGPTOAuthRuntime.create("close", agent, ".", {
    loadCredentials: () => credentials, getValidCredentials: async value => value,
    streamCodexResponse: async function* (_credentials, _model, _messages, options) {
      started();
      await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      options!.signal!.throwIfAborted();
      yield { type: "done" };
    },
  });
  const pending = runtime.prompt("wait", () => {}, new AbortController().signal);
  await ready; runtime.close();
  await assert.rejects(pending, /closed/);
});

test("OAuth provider sends actual image bytes and correctly typed assistant history", async t => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const chunks = [];
  for await (const chunk of streamCodexResponse(credentials, "gpt-5.6-sol", [
    { role: "assistant", content: "prior reply" }, { role: "user", content: "inspect", images: [{ mimeType: "image/png", data: "fixture-data" }] },
  ])) chunks.push(chunk);
  assert.equal(body.input[0].content[0].type, "output_text");
  assert.deepEqual(body.input[1].content[1], { type: "input_image", image_url: "data:image/png;base64,fixture-data" });
  assert.ok(chunks.some(chunk => chunk.text === "OK"));
});
