import assert from "node:assert/strict";
import test from "node:test";
import { createImConnection, type ImSocket } from "./imConnection";

test("reconnect restores subscriptions; offline typing and disposal do not replay", async () => {
  const sockets: ImSocket[] = [];
  const sent: string[][] = [];
  let synced = 0;
  const connection = createImConnection({
    socket: () => {
      const messages: string[] = [];
      sent.push(messages);
      const socket: ImSocket = { readyState: 0, onopen: null, onclose: null, onerror: null,
        onmessage: null, send: data => messages.push(data), close() { this.onclose?.(); } };
      sockets.push(socket);
      return socket;
    },
    connected: () => {}, event: () => {}, resync: () => { synced++; }, retryMs: 1,
  });
  connection.subscribe("conversation:a");
  connection.subscribe("conversation:b");
  connection.unsubscribe("conversation:b");
  connection.typing("conversation:a");
  sockets[0].readyState = 1;
  sockets[0].onopen?.();
  assert.deepEqual(sent[0].map(data => JSON.parse(data)), [{ type: "subscribe", channel: "conversation:a" }]);
  sockets[0].readyState = 3;
  sockets[0].onclose?.();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(sockets.length, 2);
  sockets[1].readyState = 1;
  sockets[1].onopen?.();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(synced, 2);
  connection.dispose();
  sockets[1].onclose?.();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(sockets.length, 2);
});
