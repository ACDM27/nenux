import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("profile nickname and uploaded avatar survive a state reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-profile-state-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  t.after(async () => { db.getDb().close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const userProfile = {
    nickname: "idoubi",
    imUserId: "stable-user-id",
    avatar: "data:image/png;base64,dGVybWFueQ==",
  };
  db.saveState({
    workspaces: [],
    agentConversations: [],
    userProfile,
    activeWorkspace: "",
    sidebarCollapsed: false,
  });

  assert.deepEqual(db.loadState().userProfile, userProfile);
  db.saveState({ ...db.loadState(), userProfile: { ...userProfile, nickname: "renamed" } });
  assert.equal(db.loadState().userProfile.imUserId, "stable-user-id");
  const { migrateImSchema, ImService } = await import("./imService.js");
  migrateImSchema(db.getDb());
  new ImService(db.getDb()).createDm({ userId: "default-user", targetId: "other", targetType: "user" });
  db.setMeta("userProfile", JSON.stringify({ nickname: "system-name" }));
  assert.equal(db.loadState().userProfile.imUserId, "default-user", "legacy default conversations remain reachable after system nickname initialization");
  db.saveState({ ...db.loadState(), userProfile: { nickname: "new-name" } });
  assert.equal(db.loadState().userProfile.imUserId, "default-user", "older clients cannot drop a stable identity when saving a nickname");
});
