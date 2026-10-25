import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const applicationLayouts = [
  { metadata: new URL("../package.json", import.meta.url), requirements: new URL("../resources/attachments/requirements.txt", import.meta.url) },
  { metadata: new URL("./app/package.json", import.meta.url), requirements: new URL("./resources/attachments/requirements.txt", import.meta.url) },
];
const dataDirectory = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support")
  : process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

async function readApplicationLayout() {
  // Source checkout and packaged Contents/Resources layouts share package metadata.
  for (const { metadata, requirements } of applicationLayouts) {
    let source;
    try { source = await readFile(metadata, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const { storageIdentity } = JSON.parse(source);
    if (typeof storageIdentity !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(storageIdentity)) {
      throw new Error("package.json must define a stable storageIdentity.");
    }
    return {
      runtimeDirectory: join(dataDirectory, storageIdentity, "attachment-runtime"),
      requirementsPath: fileURLToPath(requirements),
    };
  }
  throw new Error("Application storage metadata is unavailable. Supply --directory PATH and ATTACHMENT_REQUIREMENTS_PATH.");
}

async function findUv() {
  const override = process.env.ATTACHMENT_UV_PATH;
  const executable = process.platform === "win32" ? "uv.exe" : "uv";
  const candidates = override
    ? (isAbsolute(override) || override.includes("/") || override.includes("\\")
      ? [resolve(override)]
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, override)))
    : [join(homedir(), ".local", "bin", executable), join("/opt/homebrew/bin", executable), join("/usr/local/bin", executable),
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, executable))];
  for (const path of candidates) {
    try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return path; }
    catch { /* Continue through uv's supported installation locations. */ }
  }
  throw new Error("Install uv from https://docs.astral.sh/uv/getting-started/installation/ and run npm run setup:attachments again. ATTACHMENT_UV_PATH selects an explicit uv executable.");
}

function run(command, args, env, timeout = 20 * 60_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], env,
    });
    let failure;
    let outputBytes = 0;
    let escalation;
    const kill = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may already have exited. */ }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const interrupted = () => stop(new Error("Attachment setup interrupted. Run setup again to complete the isolated runtime."));
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const timer = setTimeout(() => stop(new Error(`Attachment setup timed out after ${timeout / 60_000} minutes.`)), timeout);
    const forward = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) stop(new Error("Attachment setup exceeded its output limit. Retry with a quiet uv configuration."));
      else stream.write(chunk);
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      if (failure) { kill("SIGKILL"); reject(failure); }
      else if (code !== 0) reject(new Error(`Attachment setup exited with ${code ?? signal}.`));
      else resolveRun();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let directory = process.env.ATTACHMENT_RUNTIME_DIRECTORY;
  let modelsOnly = false;
  let skipModels = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--directory") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--directory requires a runtime directory.");
      directory = args[++index];
    } else if (arg === "--models-only") modelsOnly = true;
    else if (arg === "--skip-models") skipModels = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/setup-attachments.mjs [--directory PATH] [--models-only | --skip-models]\nDefault: isolated uv Python 3.12 environment, pinned Docling 2.142.1, and local layout/table/OCR models.\nRuntime directory: ${resolve(directory ?? (await readApplicationLayout()).runtimeDirectory)}\n--models-only: provision the three models into an existing environment.\n--skip-models: install the Python environment and print the model provisioning command.\nFFmpeg and FFprobe use ATTACHMENT_FFMPEG_PATH / ATTACHMENT_FFPROBE_PATH, runtime/bin, Homebrew, or PATH.`);
      return;
    } else throw new Error(`Unknown attachment setup option: ${arg}`);
  }
  if (modelsOnly && skipModels) throw new Error("Choose either --models-only or --skip-models.");
  const layout = !directory || (!modelsOnly && !process.env.ATTACHMENT_REQUIREMENTS_PATH)
    ? await readApplicationLayout() : undefined;
  directory = resolve(directory ?? layout.runtimeDirectory);
  const requirementsPath = process.env.ATTACHMENT_REQUIREMENTS_PATH ?? layout?.requirementsPath;
  const environment = {
    ...process.env, UV_NO_PROGRESS: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HOME: join(directory, "cache", "huggingface"),
    HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "0",
    OMP_NUM_THREADS: "2", MKL_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2",
  };
  const venv = join(directory, "venv");
  const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
  await mkdir(directory, { recursive: true });
  if (!modelsOnly) {
    const uv = await findUv();
    try { await access(python); }
    catch { await run(uv, ["venv", "--python", "3.12", venv], environment); }
    await run(python, ["-I", "-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Use a Python 3.12 attachment environment.'"], environment, 30_000);
    await run(uv, ["pip", "install", "--python", python, "--requirements", requirementsPath], environment);
  }
  if (!skipModels) {
    try { await access(python); }
    catch { throw new Error("The isolated Docling environment is missing. Run npm run setup:attachments first."); }
    await run(python, ["-I", "-m", "docling.cli.tools", "models", "download", "layout", "tableformer", "rapidocr", "--rapidocr-backend-lang", "onnxruntime:ch", "--output-dir", join(directory, "models"), "--quiet"], environment);
  }
  console.log(`Attachment runtime: ${directory}\nModel provisioning: node scripts/setup-attachments.mjs --directory ${JSON.stringify(directory)} --models-only\nFFmpeg/FFprobe: install ffmpeg with your system package manager (macOS: brew install ffmpeg), or provide explicit executable paths.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
