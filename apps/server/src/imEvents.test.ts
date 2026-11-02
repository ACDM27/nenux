import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { createSubscriptionManager, registerConnection, subscribe, broadcastToChannel } from "./imEvents.js";

test("removing a member revokes an existing WebSocket subscription before delivery", () => {
  let member = true;
  const manager = createSubscriptionManager((_conversation, user) => member && user === "user");
  const events: string[] = [];
  registerConnection(manager, "connection", "user", { readyState: 1, send: (event: string) => events.push(event) } as unknown as WebSocket);
  subscribe(manager, "connection", "conversation:group");
  assert.equal(broadcastToChannel(manager, "conversation:group", "im.message", { seq: 1 }), 1);
  member = false;
  assert.equal(broadcastToChannel(manager, "conversation:group", "im.message", { seq: 2 }), 0);
  assert.equal(events.length, 1);
  assert.equal(manager.subscriptions.get("connection")?.has("conversation:group"), false);
});
