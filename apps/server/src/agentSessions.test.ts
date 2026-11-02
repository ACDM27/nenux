import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentSessions, normalizeUsageSince } from "./agentSessions.js";

const now = new Date(2026, 7, 3, 12, 0, 0);

test("usage defaults to the server's local today", () => {
  assert.equal(normalizeUsageSince(undefined, now), "2026-08-03");
});

test("usage accepts dates inside the rolling 31-day window", () => {
  assert.equal(normalizeUsageSince("2026-08-01", now), "2026-08-01");
  assert.equal(normalizeUsageSince("2026-07-04", now), "2026-07-04");
});

test("usage clamps older dates to at most 31 calendar days", () => {
  assert.equal(normalizeUsageSince("2020-01-01", now), "2026-07-04");
});

test("usage rejects invalid and future dates", () => {
  assert.equal(normalizeUsageSince("2026-02-30", now), "2026-08-03");
  assert.equal(normalizeUsageSince("2026-08-04", now), "2026-08-03");
  assert.equal(normalizeUsageSince("not-a-date", now), "2026-08-03");
});

test("session history returns newest files one page at a time", async () => {
  const originalHomedir = os.homedir;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-sessions-"));
  try {
    os.homedir = () => home;
    const dir = path.join(home, ".codex", "sessions", "2026", "08", "03");
    await fs.promises.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const id = `session-${i}`;
      const file = path.join(dir, `rollout-${i}.jsonl`);
      await fs.promises.writeFile(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { id, cwd: home, git: { branch: "main" } } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `prompt ${i}` } }),
        ].join("\n")
      );
      const mtime = new Date(2026, 7, 3, 12, i, 0);
      await fs.promises.utimes(file, mtime, mtime);
    }

    const first = await listAgentSessions("codex", [], 0, 2);
    assert.deepEqual(first.sessions?.map((session) => session.sessionId), ["session-3", "session-2"]);
    assert.equal(first.nextCursor, "2");

    const second = await listAgentSessions("codex", [], Number(first.nextCursor), 2);
    assert.deepEqual(second.sessions?.map((session) => session.sessionId), ["session-1"]);
    assert.equal(second.nextCursor, null);
  } finally {
    os.homedir = originalHomedir;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});
