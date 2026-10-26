#!/usr/bin/env node
/**
 * 仓库卫生检查：阻止缓存、构建产物、日志和大文件进入版本库。
 *
 * 用法：
 *   node scripts/check-repo-hygiene.mjs            # 检查全部已跟踪文件
 *   node scripts/check-repo-hygiene.mjs --staged   # 只检查本次提交（pre-commit 用）
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

const BLOCKED = [
  [/(^|\/)node_modules\//, "依赖目录 node_modules/"],
  [/(^|\/)out\//, "构建产物 out/"],
  [/(^|\/)dist\//, "构建产物 dist/"],
  [/(^|\/)node-compile-cache\//, "Node 编译缓存"],
  [/(^|\/)tsx-501\//, "tsx 运行时缓存"],
  [/(^|\/)\.vite\//, "Vite 缓存"],
  [/(^|\/)\.cache\//, "通用缓存目录"],
  [/(^|\/)coverage\//, "测试覆盖率产物"],
  [/(^|\/)\.DS_Store$/, "macOS 元数据"],
  [/\.log$/, "日志文件"],
  [/\.bin$/, "二进制文件"],
  [/\.tsbuildinfo$/, "TypeScript 增量构建信息"],
  [/\.(zip|tar|tgz|dmg|exe)$/, "打包/安装产物"],
];

/** 大文件白名单：确有需要跟踪时在此登记，并写明原因。 */
const SIZE_ALLOW = new Set([
  // 例："canvas/engine/editor/subset/harfbuzz/harfbuzz-wasm.ts"
]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

function listFiles(staged) {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-z"]);
  return out.split("\0").filter(Boolean);
}

const staged = process.argv.includes("--staged");
const root = repoRoot();
const files = listFiles(staged);

const blocked = [];
const oversized = [];

for (const file of files) {
  for (const [pattern, label] of BLOCKED) {
    if (pattern.test(file)) {
      blocked.push({ file, label });
      break;
    }
  }
  if (SIZE_ALLOW.has(file)) continue;
  try {
    const { size, isFile } = statSync(join(root, file));
    if (isFile && size > MAX_BYTES) oversized.push({ file, size });
  } catch {
    // 已删除或不可读的文件不参与体积检查。
  }
}

if (blocked.length === 0 && oversized.length === 0) {
  console.log(`✓ hygiene: ${files.length} 个文件检查通过${staged ? "（暂存区）" : ""}`);
  process.exit(0);
}

if (blocked.length > 0) {
  console.error(`\n✗ 发现 ${blocked.length} 个不该进入版本库的文件：\n`);
  for (const { file, label } of blocked.slice(0, 40)) console.error(`  ${file}  ← ${label}`);
  if (blocked.length > 40) console.error(`  … 另有 ${blocked.length - 40} 个`);
  console.error(`\n处理方式：git rm -r --cached <路径>，并把规则写进 .gitignore。`);
}

if (oversized.length > 0) {
  console.error(`\n✗ 发现 ${oversized.length} 个超过 ${MAX_BYTES / 1024 / 1024} MB 的文件：\n`);
  for (const { file, size } of oversized) console.error(`  ${(size / 1024 / 1024).toFixed(1)} MB  ${file}`);
  console.error(`\n处理方式：移出仓库，或确认后用 SIZE_ALLOW 登记。`);
}

process.exit(1);
