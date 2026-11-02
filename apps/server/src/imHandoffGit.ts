import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const exec = promisify(execFile);
const sensitive = /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?|secrets?(?:\..*)?|\.codex|\.termany|node_modules)(?:\/|$)/i;

export async function handoffGitState(projectPath: string) {
  const cwd = await fs.realpath(projectPath);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("project directory is not a directory");
  const run = async (args: string[]) => {
    try { return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch (error) {
      if ((error as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return String((error as any).stdout || "").slice(0, 100_000);
      throw error;
    }
  };
  const warnings: string[] = [];
  try {
    const branch = (await run(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => run(["rev-parse", "--short", "HEAD"]))).trim();
    const status = (await run(["status", "--porcelain=v1", "-z"])).split("\0");
    const files: string[] = [];
    for (let index = 0; index < status.length; index++) {
      const entry = status[index];
      if (entry.length < 4) continue;
      const name = entry.slice(3).replace(/\\/g, "/");
      if (!sensitive.test(name)) files.push(name);
      if (/[RC]/.test(entry.slice(0, 2))) index++;
    }
    if (files.length > 50) warnings.push("Git 文件列表及 diff 已限制为前 50 个文件");
    const selected = files.slice(0, 50);
    let diff = "";
    if (selected.length) {
      diff = [await run(["diff", "--no-ext-diff", "--no-textconv", "--", ...selected]),
        await run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", ...selected])].filter(Boolean).join("\n");
    }
    if (diff.length > 32_000) warnings.push("Git diff 已截断为 32000 字符；未跟踪文件仅列出名称");
    diff = diff.slice(0, 32_000).replace(/((?:api[_-]?key|secret|token|password|authorization)["'\s]*[:=][\s"']*)[^\s"',;}]+/gi, "$1[REDACTED]");
    return { projectPath: cwd, gitBranch: branch || null, modifiedFiles: selected, uncommittedDiff: diff || null, warnings };
  } catch {
    warnings.push("未能读取 Git 状态：项目不是 Git 仓库或 Git 不可用");
    return { projectPath: cwd, gitBranch: null, modifiedFiles: [], uncommittedDiff: null, warnings };
  }
}
