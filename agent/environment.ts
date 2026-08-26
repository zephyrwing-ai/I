/**
 * 执行层 — 跟 PI 的 BashOperations 同一个模式。
 * 接口只定义签名，实现随便换。本机 / Docker / SSH 都只改这里。
 */

import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { BashOperations, ExecOptions, ExecResult } from "./types.js";

// ── 配置 ──
const MAX_OUTPUT = 10_000;
const TRUNCATE_KEEP = 6_000;

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

// ═══════════════════════════════════════════════════════════
// 实现 2：Docker 沙箱
// ═══════════════════════════════════════════════════════════

let containerId: string | undefined;

export function createDockerBashOps(image: string = "ubuntu:22.04"): BashOperations {
  return {
    async exec(command: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
      if (!containerId) {
        containerId = execSync(
          `docker run -d --rm -v "${cwd}:${cwd}" -w "${cwd}" ${image} sleep 2h`,
          { encoding: "utf-8" }
        ).trim();
        console.log(`🐳 容器已启动: ${containerId.slice(0, 12)}`);
        process.on("exit", () => {
          if (containerId) execSync(`docker stop ${containerId}`);
        });
      }

      const escaped = command.replace(/'/g, `'\\''`);
      const dockerCmd = `docker exec ${containerId} bash -c '${escaped}'`;
      return runWithSpawn(dockerCmd, cwd, opts);
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 通用执行 + 截断逻辑
// ═══════════════════════════════════════════════════════════

function runWithSpawn(cmd: string, cwd: string, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", cmd], { cwd, timeout: opts.timeout ? opts.timeout * 1000 : 30_000 });
    const chunks: string[] = [];
    let totalBytes = 0;

    child.stdout.on("data", (d: Buffer) => { chunks.push(d.toString()); totalBytes += d.length; });
    child.stderr.on("data", (d: Buffer) => { chunks.push(d.toString()); totalBytes += d.length; });

    opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });

    child.on("close", (code) => {
      const raw = chunks.join("");
      // 截断
      if (raw.length > MAX_OUTPUT) {
        const dir = mkdtempSync(join(tmpdir(), "ts-agent-"));
        const fullPath = join(dir, "full_output.log");
        writeFileSync(fullPath, raw);
        const tail = raw.slice(-TRUNCATE_KEEP);
        resolve({
          output: tail + `\n\n... 省略前 ${raw.length - TRUNCATE_KEEP} 字符 ...\n完整输出: ${fullPath}`,
          returncode: code ?? -1,
          truncated: true,
          fullOutputPath: fullPath,
        });
      } else {
        resolve({ output: raw, returncode: code ?? -1, truncated: false });
      }
    });

    child.on("error", (err) => reject(err));
  });
}
