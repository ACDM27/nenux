import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

test("real server: two IM clients receive persisted ACP team results and reconnect successfully", { timeout: 45_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-im-e2e-"));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, USERPROFILE: directory, HOME: directory, TERMANY_DATA_DIR: path.join(directory, ".termany"), TERMANY_PORT: String(port) },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-6000); });
  child.stdout.resume();
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(json));
    return json.data ?? json;
  };
  let ready = false;
  for (let count = 0; count < 100; count++) {
    if (child.exitCode !== null) assert.fail(`server exited: ${diagnostic}`);
    try { await request("/api/im/contacts"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, diagnostic);
  const preflight = await fetch(`${base}/api/im/conversations/test/attachments`, { method: "OPTIONS", headers: {
    Origin: "http://localhost:15174", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-file-name",
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers")!, /X-File-Name/i);
  assert.match(preflight.headers.get("access-control-allow-methods")!, /DELETE/);
  const fixture = fileURLToPath(new URL("../tests/fixtures/im-team-acp.mjs", import.meta.url));
  await request("/api/agents", "PUT", { agents: ["Researcher", "Writer"].map((name, index) => ({
    id: `bot-${index}`, name, enabled: true, command: process.execPath, args: "", builtIn: false,
    runtime: { protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath, args: JSON.stringify(fixture) },
  })) });
  const conv = await request("/api/im/conversations/group", "POST", { title: "Acceptance team", ownerId: "human-a",
    members: [{ id: "human-b", type: "user" }, { id: "bot-0", type: "bot" }, { id: "bot-1", type: "bot" }] });
  const events: any[][] = [[], [], []];
  const connect = async (user: string, index: number) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?im=1&user=${user}`);
    sockets.push(socket);
    socket.on("message", raw => { events[index].push(JSON.parse(raw.toString())); });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", channel: `conversation:${conv.id}` }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return socket;
  };
  await connect("human-a", 0); const second = await connect("human-b", 1);
  const body = { senderId: "human-a", content: "Please research, write, and consolidate", clientRequestId: "acceptance-1" };
  const message = await request(`/api/im/conversations/${conv.id}/messages`, "POST", body);
  assert.equal((await request(`/api/im/conversations/${conv.id}/messages`, "POST", body)).id, message.id);
  let tasks: any[] = [];
  for (let count = 0; count < 150; count++) {
    tasks = await request(`/api/im/conversations/${conv.id}/tasks?user_id=human-a`);
    if (tasks[0] && ["succeeded", "failed"].includes(tasks[0].status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "succeeded", JSON.stringify(tasks));
  assert.deepEqual(tasks[0].steps.map((step: any) => step.agentId), ["bot-0", "bot-1", "bot-0"]);
  const history = await request(`/api/im/conversations/${conv.id}/messages?user_id=human-b`);
  assert.equal(history.items.length, 4);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(events[0].some(event => event.type === "im.message"));
  assert.ok(events[1].some(event => event.type === "im.message"));
  second.close(); await once(second, "close");
  await connect("human-b", 2);
  await request(`/api/im/conversations/${conv.id}/messages`, "POST", { senderId: "human-a", content: "@Researcher follow up", clientRequestId: "acceptance-2" });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.ok(events[2].some(event => event.type === "im.message"), "reconnected client receives conversation updates");
});
