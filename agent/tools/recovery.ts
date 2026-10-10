import fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolResult, ToolRecoveryResult, ToolCheckpoint, ToolExecutionContext } from "./types.js";
import { containsDirectory, isRecord, observeFile, readRegularFile, sameFileState, stagingName, syncObservedFile, syncPublicationDirectories, withFilePublicationLock } from "./atomic-file.js";
import type { DirectoryBoundary, FilePublicationPlan, FileState, PresentFileState, StagingReceipt } from "./atomic-file.js";

export interface FileCheckpointData {
  path: string;
  beforeHash: string | null;
  afterHash: string;
  operation: "created" | "updated";
  mediaType: string;
  byteSize: number;
}

export function resolveToolPath(value: string, cwd: string): string {
  return resolve(cwd, value);
}

export function checkpointForFilePublication(plan: FilePublicationPlan, mediaType: string): ToolCheckpoint {
  return { version: 2, kind: "text_file", data: {
    path: plan.source.path,
    targetPath: plan.source.targetPath,
    before: { ...plan.source.state },
    beforeHash: plan.source.state.exists ? plan.source.state.hash : null,
    afterHash: plan.afterHash,
    afterMode: plan.afterMode,
    operation: plan.source.state.exists ? "updated" : "created",
    mediaType,
    byteSize: plan.bytes.length,
    staging: { ...plan.staging },
    directoryBoundary: { ...plan.directoryBoundary },
  } };
}

interface PublicationCheckpoint extends FileCheckpointData {
  version: 2;
  targetPath: string;
  before: FileState;
  afterMode: number;
  staging: StagingReceipt;
  directoryBoundary?: DirectoryBoundary;
}

type ValidatedCheckpoint = (FileCheckpointData & { version: 1 }) | PublicationCheckpoint;

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBefore(value: unknown): FileState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.exists === false) return { exists: false };
  if (value.exists !== true || !validHash(value.hash) || !nonnegativeInteger(value.dev)
    || !nonnegativeInteger(value.ino) || !nonnegativeInteger(value.mode) || (value.mode & constants.S_IFMT) !== constants.S_IFREG
    || !nonnegativeInteger(value.uid) || !nonnegativeInteger(value.gid) || value.nlink !== 1 || !nonnegativeInteger(value.size)
    || typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs)
    || typeof value.ctimeMs !== "number" || !Number.isFinite(value.ctimeMs)) return undefined;
  return { exists: true, hash: value.hash, dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid,
    gid: value.gid, nlink: value.nlink, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function parseStaging(value: unknown, context: ToolExecutionContext): StagingReceipt | undefined {
  if (!isRecord(value) || typeof value.invocationId !== "string" || !value.invocationId || value.invocationId.includes("\0")
    || !nonnegativeInteger(value.attempt) || value.attempt < 1 || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)
    || typeof value.relativePath !== "string" || value.relativePath !== stagingName(value.invocationId, value.attempt, value.token)
    || (context.invocationId !== undefined && context.invocationId !== value.invocationId)
    || (context.attempt !== undefined && context.attempt !== value.attempt)) return undefined;
  return { invocationId: value.invocationId, attempt: value.attempt, token: value.token, relativePath: value.relativePath };
}

function parseFileCheckpoint(checkpoint: unknown, context: ToolExecutionContext): ValidatedCheckpoint | undefined {
  if (!isRecord(checkpoint) || checkpoint.kind !== "text_file" || (checkpoint.version !== 1 && checkpoint.version !== 2)
    || !isRecord(checkpoint.data)) return undefined;
  const data = checkpoint.data;
  if (!validPath(data.path) || (data.beforeHash !== null && !validHash(data.beforeHash)) || !validHash(data.afterHash)
    || (data.operation !== "created" && data.operation !== "updated") || (data.operation === "created") !== (data.beforeHash === null)
    || typeof data.mediaType !== "string" || !data.mediaType || !nonnegativeInteger(data.byteSize)) return undefined;
  const common: FileCheckpointData = { path: data.path, beforeHash: data.beforeHash, afterHash: data.afterHash,
    operation: data.operation, mediaType: data.mediaType, byteSize: data.byteSize };
  if (checkpoint.version === 1) return { ...common, version: 1 };
  const before = parseBefore(data.before);
  const staging = parseStaging(data.staging, context);
  if (!validPath(data.targetPath) || !before || !staging || (before.exists ? before.hash : null) !== data.beforeHash
    || !nonnegativeInteger(data.afterMode) || data.afterMode > 0o7777
    || (before.exists && (before.mode & 0o7777) !== data.afterMode)) return undefined;
  let directoryBoundary: DirectoryBoundary | undefined;
  if (data.directoryBoundary !== undefined) {
    const boundary = data.directoryBoundary;
    if (!isRecord(boundary) || !validPath(boundary.path) || !nonnegativeInteger(boundary.dev) || !nonnegativeInteger(boundary.ino)
      || !containsDirectory(boundary.path, dirname(data.targetPath))) return undefined;
    directoryBoundary = { path: boundary.path, dev: boundary.dev, ino: boundary.ino };
  }
  return { ...common, version: 2, targetPath: data.targetPath, before, afterMode: data.afterMode, staging, directoryBoundary };
}

function samePermissions(before: PresentFileState, current: PresentFileState): boolean {
  return current.mode === before.mode && current.uid === before.uid && current.gid === before.gid;
}

/** Recovery removes only an exact receipt name holding the expected complete bytes. */
async function cleanupRecordedStaging(data: PublicationCheckpoint): Promise<void> {
  const path = resolve(dirname(data.targetPath), data.staging.relativePath);
  const staged = await readRegularFile(path);
  if (!staged.state.exists) return;
  if (staged.state.hash !== data.afterHash || staged.state.size !== data.byteSize || (staged.state.mode & 0o7777) !== data.afterMode
    || (data.before.exists && !samePermissions(data.before, staged.state))) {
    throw new Error("Staging bytes or metadata differ from the attempt receipt.");
  }
  const entry = await fs.lstat(path);
  if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== staged.state.dev || entry.ino !== staged.state.ino) {
    throw new Error("Staging identity changed during recovery inspection.");
  }
  await fs.unlink(path);
}

export async function reconcileTextFile(
  checkpoint: ToolCheckpoint | undefined,
  context: ToolExecutionContext,
  label: string,
  inputPath: unknown,
): Promise<ToolRecoveryResult> {
  const data = parseFileCheckpoint(checkpoint, context);
  if (!data || typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0") || resolveToolPath(inputPath, context.cwd) !== data.path) {
    return { kind: "interrupted", reason: `${label} recovery checkpoint is unavailable or unsupported.` };
  }
  try {
    const observed = await observeFile(data.path);
    const targetPath = data.version === 2 ? data.targetPath : observed.targetPath;
    return await withFilePublicationLock(targetPath, context.signal, async () => {
      const current = await observeFile(data.path);
      if (current.targetPath !== targetPath) return { kind: "interrupted", reason: `${label} symbolic link target differs from its checkpoint.` };
      const state = current.state;
      const currentHash = state.exists ? state.hash : null;
      const after = state.exists && currentHash === data.afterHash && state.size === data.byteSize
        && (data.version === 1 || ((state.mode & 0o7777) === data.afterMode && (!data.before.exists || samePermissions(data.before, state))));
      const before = currentHash === data.beforeHash && (data.version === 1 || sameFileState(state, data.before));
      if ((!after && !before) || (currentHash === data.afterHash && !after)) return { kind: "interrupted", reason: `${label} target differs from both recorded before and after states: ${data.path}` };
      if (data.version === 2) await cleanupRecordedStaging(data);
      if (after) {
        await syncObservedFile(current);
        await syncPublicationDirectories(targetPath, data.version === 2 ? data.directoryBoundary : undefined);
        const durable = await observeFile(data.path);
        if (durable.targetPath !== targetPath || !sameFileState(current.state, durable.state)) {
          return { kind: "interrupted", reason: `${label} target changed during durability confirmation: ${data.path}` };
        }
        const result: ToolResult = {
          ok: true, output: `${label} was already applied and its result was recovered: ${data.path}`, returncode: 0, truncated: false,
          artifacts: [{ path: data.path, operation: data.operation, mediaType: data.mediaType, byteSize: data.byteSize, updatedAt: new Date().toISOString() }],
        };
        return { kind: "succeeded", result };
      }
      return { kind: "retry", reason: `${label} was not published; retrying from the recorded before state.` };
    });
  } catch (error) {
    return { kind: "interrupted", reason: `${label} recovery could not verify ${data.path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
