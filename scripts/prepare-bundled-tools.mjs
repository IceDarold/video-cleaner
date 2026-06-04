import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const toolsDir = resolve(root, "src-tauri/binaries/tools");
const autoEditorVersion = "30.4.0";

mkdirSync(toolsDir, { recursive: true });

copyExecutable(require("ffmpeg-static"), resolve(toolsDir, "ffmpeg"));
copyExecutable(require("@ffprobe-installer/ffprobe").path, resolve(toolsDir, "ffprobe"));

const bundledAutoEditor = resolve(toolsDir, "auto-editor");
if (!isAutoEditorReady(bundledAutoEditor)) {
  const providedAutoEditor = process.env.AUTO_EDITOR_BINARY;
  if (providedAutoEditor) {
    copyExecutable(providedAutoEditor, bundledAutoEditor);
  } else {
    run("bash", [resolve(root, "scripts/build-auto-editor.sh")], root);
  }
}

if (!isAutoEditorReady(bundledAutoEditor)) {
  throw new Error(`Bundled auto-editor is missing or is not ${autoEditorVersion}`);
}

for (const name of ["auto-editor", "ffmpeg", "ffprobe"]) {
  const file = resolve(toolsDir, name);
  chmodSync(file, 0o755);
  run(file, name === "auto-editor" ? ["--version"] : ["-version"], root, { allowOutput: true });
}

function copyExecutable(source, destination) {
  if (!source || !existsSync(source)) {
    throw new Error(`Missing executable source: ${source}`);
  }
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function isAutoEditorReady(path) {
  if (!existsSync(path)) return false;
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === autoEditorVersion;
}

function run(command, args, cwd, options = {}) {
  const stdio = options.allowOutput ? "pipe" : "inherit";
  const output = execFileSync(command, args, { cwd, stdio, encoding: "utf8" });
  if (options.allowOutput && output) {
    process.stdout.write(output.split("\n").slice(0, 2).join("\n") + "\n");
  }
}
