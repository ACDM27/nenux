import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImService, migrateImSchema } from "./imService.js";
import { ImAttachmentService, IM_ATTACHMENT_LIMIT } from "./imAttachments.js";
import { HandoffService } from "./imHandoff.js";
import { createImHttpHandler } from "./imRoutes.js";

test("IM attachments: upload, server-owned metadata, authorized bytes, preview and rejection boundaries", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-im-files-"));
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const attachments = new ImAttachmentService(db, im, directory);
  const conv = im.createDm({ userId: "a", targetId: "b", targetType: "user" });
  const other = im.createDm({ userId: "a", targetId: "c", targetType: "user" });
  const server = createServer(createImHttpHandler({ imService: im, attachments, handoffService: new HandoffService(db, im),
    readJson: async req => { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body || "{}"); } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/im`;
  const upload = (userId: string, name: string, data: Buffer) => fetch(`${base}/conversations/${conv.id}/attachments?user_id=${userId}`, {
    method: "POST", headers: { "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }, body: data,
  });
  const content = Buffer.from("Acceptance file\n中文内容");
  const response = await upload("a", "../../notes.txt", content);
  assert.equal(response.status, 200);
  const file = ((await response.json()) as any).data;
  assert.equal(file.name, "notes.txt");
  assert.equal(file.size, content.length);
  const sent = await fetch(`${base}/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "a", content: "", attachmentIds: [file.id], metadata: { attachments: [{ id: "forged" }] } }) });
  assert.equal(sent.status, 200);
  assert.equal(((await sent.json()) as any).data.metadata.attachments[0].id, file.id);
  const download = await fetch(`${base}/attachments/${file.id}?user_id=b`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  assert.equal((await fetch(`${base}/attachments/${file.id}?user_id=c`)).status, 403);
  assert.equal((await fetch(`${base}/attachments/${file.id}/preview?user_id=a`)).status, 400);
  assert.equal((await upload("c", "x.txt", content)).status, 403);
  assert.equal((await upload("a", "x.html", content)).status, 400);
  assert.equal((await upload("a", "fake.png", content)).status, 400);
  assert.equal((await upload("a", "huge.txt", Buffer.alloc(IM_ATTACHMENT_LIMIT + 1, 65))).status, 413);
  assert.throws(() => attachments.resolve([file.id], other.id, "a"), /another conversation/);
  assert.throws(() => attachments.filePath("../outside"), /invalid/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1kAAAAASUVORK5CYII=", "base64");
  const image = ((await (await upload("a", "pixel.png", png)).json()) as any).data;
  const preview = await fetch(`${base}/attachments/${image.id}/preview?user_id=b`);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
});
