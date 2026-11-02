import { execFile, type ChildProcess } from "node:child_process";

const stopped = new WeakSet<ChildProcess>();

/** Native CLIs can relaunch Node with different memory flags. Stop that child
 * as well as the launcher when the ACP session closes or fails to start. */
export function stopAgentProcess(child: ChildProcess): void {
  if (!child.pid || stopped.has(child)) return;
  stopped.add(child);
  const pid = child.pid;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error) child.kill();
    });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { child.kill(); }
  // Give the CLI time to flush its session, then reap descendants that ignored
  // SIGTERM. The detached process group belongs exclusively to this runtime.
  const timer = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }, 1_500);
  timer.unref();
}
