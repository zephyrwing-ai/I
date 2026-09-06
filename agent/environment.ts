import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { BashOperations, ExecOptions, ExecResult, FileArtifact } from "./types.js";

// ── 配置 ──
const MAX_OUTPUT = 10_000;
const TRUNCATE_KEEP = 6_000;
const MAX_SNAPSHOT_ENTRIES = 12_000;
const MAX_SNAPSHOT_FILES = 8_000;
const MAX_SNAPSHOT_DEPTH = 16;
const MAX_ARTIFACTS_PER_COMMAND = 256;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".superpowers",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "venv",
]);

interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mediaType: string;
  updatedAt: string;
}

interface DirectorySnapshot {
  files: Map<string, FileStamp>;
  complete: boolean;
}

// ═══════════════════════════════════════════════════════════
// 实现 1：本机执行
// ═══════════════════════════════════════════════════════════

export function createLocalBashOps(): BashOperations {
  return {
    async exec(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
      return runWithSpawn(command, cwd, opts);
    },
  };
}

// 通用执行 + 截断逻辑
// ═══════════════════════════════════════════════════════════

function runWithSpawn(cmd: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  return runWithArtifactSnapshot(cmd, cwd, opts);
}

async function runWithArtifactSnapshot(cmd: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  const before = await snapshotDirectory(cwd);
  const result = await spawnCommand(cmd, cwd, opts);
  const after = await snapshotDirectory(cwd);
  const artifacts = diffSnapshots(before, after);
  return artifacts.length > 0 ? { ...result, artifacts } : result;
}

function spawnCommand(cmd: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("命令已取消。"));
      return;
    }

    const child = spawn("bash", ["-c", cmd], { cwd, timeout: opts.timeout ? opts.timeout * 1000 : 30_000 });
    const chunks: string[] = [];
    child.stdout.on("data", (d: Buffer) => { chunks.push(d.toString()); });
    child.stderr.on("data", (d: Buffer) => { chunks.push(d.toString()); });

    let settled = false;
    const abort = (): void => { child.kill("SIGKILL"); };
    const cleanup = (): void => { opts.signal?.removeEventListener("abort", abort); };
    opts.signal?.addEventListener("abort", abort, { once: true });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = chunks.join("");
      if (raw.length > MAX_OUTPUT) {
        const dir = mkdtempSync(join(tmpdir(), "ts-agent-"));
        const fullPath = join(dir, "full_output.log");
        writeFileSync(fullPath, raw);
        const tail = raw.slice(-TRUNCATE_KEEP);
        resolve({
          output: tail + `\n\n... 省略前 ${raw.length - TRUNCATE_KEEP} 字符，完整输出已保存到内部临时文件 ...`,
          returncode: code ?? -1,
          truncated: true,
          fullOutputPath: fullPath,
        });
      } else {
        resolve({ output: raw, returncode: code ?? -1, truncated: false });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

async function snapshotDirectory(cwd: string): Promise<DirectorySnapshot> {
  const files = new Map<string, FileStamp>();
  let complete = true;
  let root: string;

  try {
    root = await realpath(cwd);
  } catch {
    return { files, complete: false };
  }

  const directories: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visitedEntries = 0;

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) break;

    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      complete = false;
      continue;
    }

    try {
      for await (const entry of directory) {
        visitedEntries += 1;
        if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
          complete = false;
          return { files, complete };
        }

        const entryPath = join(current.path, entry.name);
        let stats;
        try {
          stats = await lstat(entryPath);
        } catch {
          complete = false;
          continue;
        }

        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          if (SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
          if (current.depth >= MAX_SNAPSHOT_DEPTH) {
            complete = false;
            continue;
          }
          directories.push({ path: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (!stats.isFile()) continue;
        if (files.size >= MAX_SNAPSHOT_FILES) {
          complete = false;
          return { files, complete };
        }

        files.set(entryPath, {
          path: entryPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          mediaType: mediaTypeForPath(entryPath),
          updatedAt: stats.mtime.toISOString(),
        });
      }
    } catch {
      complete = false;
    }
  }

  return { files, complete };
}

function diffSnapshots(before: DirectorySnapshot, after: DirectorySnapshot): FileArtifact[] {
  const artifacts: FileArtifact[] = [];

  for (const [path, current] of after.files) {
    const previous = before.files.get(path);
    let operation: FileArtifact["operation"] | undefined;

    if (!previous) {
      if (before.complete) operation = "created";
    } else if (
      previous.size !== current.size
      || previous.mtimeMs !== current.mtimeMs
      || previous.ctimeMs !== current.ctimeMs
    ) {
      operation = "updated";
    }

    if (!operation) continue;
    artifacts.push({
      path: current.path,
      operation,
      mediaType: current.mediaType,
      byteSize: current.size,
      updatedAt: current.updatedAt,
    });
    if (artifacts.length >= MAX_ARTIFACTS_PER_COMMAND) break;
  }

  return artifacts;
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".md":
    case ".markdown": return "text/markdown";
    case ".json": return "application/json";
    case ".html":
    case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".csv": return "text/csv";
    case ".xml": return "application/xml";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs": return "text/javascript";
    case ".ts":
    case ".tsx": return "text/typescript";
    case ".txt":
    case ".log":
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".py":
    case ".rb":
    case ".go":
    case ".rs":
    case ".java":
    case ".kt":
    case ".swift":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".sql":
    case ".toml":
    case ".ini":
    case ".conf": return "text/plain";
    default: return "application/octet-stream";
  }
}
