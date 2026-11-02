import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { managedAcpAdapterPath, prepareManagedAcpLaunch } from "./managedAcp.js";

for (const id of ["claude", "codex"] as const) {
  test(`${id} managed ACP reuses the user's CLI with Termany's Node`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `termany-${id}-managed-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const cli = path.join(directory, id);
    await fs.writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const runtime = { protocol: "acp" as const, distribution: "managed" as const, modelSource: "agent" as const, command: `${id}-agent-acp`, args: "" };
    assert.equal(runtime?.protocol, "acp");
    if (!runtime || runtime.protocol !== "acp") return;

    const launch = await prepareManagedAcpLaunch({
      id,
      name: id,
      command: cli,
      args: "",
      enabled: true,
      builtIn: true,
      runtime,
    }, { PATH: "/usr/bin:/bin" });

    assert.equal(launch.command, process.execPath);
    assert.equal(launch.args[0], managedAcpAdapterPath(id));
    assert.equal(launch.cliPath, cli);
    assert.ok(launch.env.PATH?.startsWith(`${path.dirname(process.execPath)}${path.delimiter}`));
    assert.equal(
      launch.env[id === "claude" ? "CLAUDE_CODE_EXECUTABLE" : "CODEX_PATH"],
      cli
    );
  });
}

test("managed ACP rejects agents without a packaged bridge", async () => {
  await assert.rejects(
    prepareManagedAcpLaunch({
      id: "custom",
      name: "Custom",
      command: process.execPath,
      args: "",
      enabled: true,
      builtIn: false,
      runtime: {
        protocol: "acp",
        command: "custom-acp",
        args: "",
        distribution: "managed",
        modelSource: "agent",
      },
    }, process.env),
    /no managed ACP bridge/
  );
});
