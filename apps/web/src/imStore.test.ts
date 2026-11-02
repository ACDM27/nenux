import assert from "node:assert/strict";
import test from "node:test";
import { useImStore } from "./imStore";
import { imApi, type ImMessage } from "./imClient";

const message = (id: number, conversationId = "a"): ImMessage => ({
  id, conversationId, seq: id, content: `message ${id}`, senderId: "other",
  senderType: "user", role: "user", messageType: "text", metadata: {},
  replyToSeq: null, isDeleted: false, editedAt: null, createdAt: id,
  sidechainId: null, isPinned: false, replyGroupId: null,
});

test("reconnect fills gaps larger than one page", async t => {
  const calls: Array<number | undefined> = [];
  t.mock.method(imApi, "getMessages", async (_id: string, opts?: { beforeSeq?: number }) => {
    calls.push(opts?.beforeSeq);
    const start = !opts?.beforeSeq ? 81 : opts.beforeSeq === 81 ? 41 : 2;
    return { items: Array.from({ length: start === 2 ? 39 : 40 }, (_, i) => message(start + i)), hasMore: start !== 2, nextCursor: start === 2 ? null : start };
  });
  t.mock.method(imApi, "markAsRead", async () => {});
  useImStore.setState({ userId: "user", activeConversationId: "a", messages: [message(1), message(2)] });
  await useImStore.getState().loadMessages("a");
  assert.deepEqual(calls, [undefined, 81, 41]);
  assert.deepEqual(useImStore.getState().messages.map(m => m.seq), Array.from({ length: 119 }, (_, i) => i + 2));
});

test("clearing search invalidates its pending response", async t => {
  let resolve!: (items: any[]) => void;
  t.mock.method(imApi, "search", () => new Promise<any[]>(r => { resolve = r; }));
  const pending = useImStore.getState().search("old");
  useImStore.getState().clearSearch();
  resolve([{ content: "stale" }]); await pending;
  assert.deepEqual(useImStore.getState().searchResults, []);
  assert.equal(useImStore.getState().searchQuery, "");
});

test("sending in the active conversation marks its message read", async t => {
  t.mock.method(imApi, "sendMessage", async () => message(9));
  const reads: unknown[][] = [];
  t.mock.method(imApi, "markAsRead", async (...args: unknown[]) => { reads.push(args); });
  useImStore.setState({ userId: "user", activeConversationId: "a", messages: [], unreadCounts: new Map([["a", 1]]) });
  await useImStore.getState().sendMessage("message 9");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [["a", "user", 9]]);
  assert.equal(useImStore.getState().unreadCounts.get("a"), 0);
});

test("IM messages are deduplicated, ordered and isolated by active conversation", () => {
  useImStore.setState({ activeConversationId: "a", messages: [], conversations: [] });
  const store = useImStore.getState();
  store.appendMessage(message(2));
  store.appendMessage(message(1));
  store.appendMessage(message(2));
  store.appendMessage(message(3, "b"));
  assert.deepEqual(useImStore.getState().messages.map(m => m.id), [1, 2]);
});

test("late history cannot overwrite another conversation; read follows loaded messages", async t => {
  let resolve!: (page: { items: ImMessage[]; nextCursor: null; hasMore: boolean }) => void;
  t.mock.method(imApi, "getMessages", () => new Promise(r => { resolve = r; }));
  const reads: unknown[][] = [];
  t.mock.method(imApi, "markAsRead", async (...args: unknown[]) => { reads.push(args); });
  useImStore.setState({ userId: "user", activeConversationId: "a", messages: [] });
  const pending = useImStore.getState().loadMessages("a");
  useImStore.getState().setActiveConversation(null);
  resolve({ items: [message(4)], nextCursor: null, hasMore: false });
  await pending;
  assert.deepEqual(useImStore.getState().messages, []);
  assert.deepEqual(reads, []);

  useImStore.setState({ activeConversationId: "a" });
  const loaded = useImStore.getState().loadMessages("a");
  useImStore.getState().appendMessage(message(5));
  resolve({ items: [message(4)], nextCursor: null, hasMore: false });
  await loaded;
  assert.deepEqual(useImStore.getState().messages.map(m => m.id), [4, 5]);
  assert.deepEqual(reads, [["a", "user", 5]]);
});

test("changing user clears private IM data", () => {
  useImStore.setState({ userId: "old", activeConversationId: "a", messages: [message(1)] });
  useImStore.getState().setUserId("new");
  assert.equal(useImStore.getState().activeConversationId, null);
  assert.deepEqual(useImStore.getState().messages, []);
});

test("reconnect history refresh removes withdrawn messages and updates edited content", async t => {
  t.mock.method(imApi, "getMessages", async () => ({ items: [{ ...message(2), content: "edited" }], nextCursor: null, hasMore: false }));
  t.mock.method(imApi, "markAsRead", async () => {});
  useImStore.setState({ userId: "user", activeConversationId: "a", messages: [message(1), message(2)] });
  await useImStore.getState().loadMessages("a");
  assert.deepEqual(useImStore.getState().messages.map(item => item.id), [2]);
  assert.equal(useImStore.getState().messages[0].content, "edited");
});
