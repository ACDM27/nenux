import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const check = spawnSync(process.execPath, [require.resolve("typescript/lib/tsc.js"), "--noEmit"], { stdio: "inherit", windowsHide: true });
if (check.error) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);

if (process.platform === "win32") {
  // esbuild transfers large transform inputs using temp files, then removes
  // them in its Go process. Windows file scanners can still hold the input at
  // that instant. Its normal write-failure path transfers the same input over
  // the service pipe instead. Select that path for large esbuild temp inputs;
  // all transformation, target checks, and production minification stay on.
  const writeFile = fs.writeFile;
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  fs.writeFile = function (file, ...args) {
    const callback = args.at(-1);
    if (typeof file === "string" && path.dirname(path.resolve(file)).toLowerCase() === temp &&
      /^esbuild-[a-f0-9]+$/.test(path.basename(file)) && typeof callback === "function") {
      queueMicrotask(() => callback(Object.assign(new Error("Use esbuild pipe transport on Windows"), { code: "EACCES" })));
      return;
    }
    return writeFile.call(this, file, ...args);
  };
}

const demo = process.argv.includes("--demo");
if (demo) process.env.VITE_DEMO = "1";
const { build } = await import("vite");
await build(demo ? { base: "/demo/", build: { outDir: "dist-demo" } } : {});
