import fs, { type FileHandle } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { PreparedToolExecution, ToolCheckpoint, ToolExecutionContext, ToolResult } from "./types.js";

export interface PresentFileState {
  exists: true;
  hash: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export type FileState = PresentFileState | { exists: false };

export interface FileObservation {
  path: string;
  targetPath: string;
  state: FileState;
  bytes: Buffer | null;
}

export interface StagingReceipt {
  invocationId: string;
  attempt: number;
  token: string;
  relativePath: string;
}

export interface DirectoryBoundary {
  path: string;
  dev: number;
  ino: number;
}

export interface FilePublicationPlan {
  source: FileObservation;
  bytes: Buffer;
  afterHash: string;
  afterMode: number;
  staging: StagingReceipt;
  directoryBoundary: DirectoryBoundary;
  cwd: string;
  invocationId?: string;
  attempt?: number;
}

export class FilePublicationError extends Error {
  constructor(public readonly code: string, message: string, public readonly published = false) {
    super(message);
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function checkFileCancellation(context: ToolExecutionContext): void {
  if (context.signal?.aborted) throw new FilePublicationError("cancelled", "The attempt was cancelled before publication.");
}

export function fileErrorResult(label: string, error: unknown, fallback = "write_failed"): ToolResult {
  const code = error instanceof FilePublicationError ? error.code
    : hasCode(error, "EACCES") || hasCode(error, "EPERM") ? "permission_denied"
    : hasCode(error, "ENOENT") ? "not_found" : fallback;
  return { ok: false, output: `${label} failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: code };
}

/** Follow existing and dangling symlinks, including links in missing paths' ancestors. */
async function physicalPath(path: string, depth = 0): Promise<string> {
  if (depth > 64) throw new FilePublicationError("unsupported_file", "The target's symbolic link chain is too deep.");
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  try {
    const entry = await fs.lstat(path);
    if (entry.isSymbolicLink()) return physicalPath(resolve(dirname(path), await fs.readlink(path)), depth + 1);
    // A concurrently created entry is resolved again and verified by the reader.
    return await fs.realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new FilePublicationError("not_found", `The filesystem root is unavailable: ${path}`);
  return resolve(await physicalPath(parent, depth + 1), basename(path));
}

function assertRegular(stats: Stats, path: string): void {
  if (stats.isDirectory()) throw new FilePublicationError("target_is_directory", `The target is a directory: ${path}`);
  if (!stats.isFile()) throw new FilePublicationError("unsupported_file", `Atomic publication requires a regular file: ${path}`);
  if (stats.nlink !== 1) throw new FilePublicationError("unsupported_file", `Atomic publication requires a single-link file: ${path}`);
}

function sameMetadata(left: Stats | PresentFileState, right: Stats | PresentFileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function sameFileState(left: FileState, right: FileState): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.hash === right.hash && sameMetadata(left, right);
}

/** Read raw bytes from one inode; only ENOENT denotes absence. */
export async function readRegularFile(path: string): Promise<{ state: FileState; bytes: Buffer | null }> {
  let entry: Stats;
  try {
    entry = await fs.lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { state: { exists: false }, bytes: null };
    throw error;
  }
  assertRegular(entry, path);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assertRegular(before, path);
    if (!sameMetadata(entry, before)) throw new FilePublicationError("file_changed", `The target changed while opening: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(path);
    if (!sameMetadata(before, after) || !sameMetadata(after, current) || bytes.length !== after.size) {
      throw new FilePublicationError("file_changed", `The target changed while reading: ${path}`);
    }
    return {
      state: { exists: true, hash: hashBytes(bytes), dev: after.dev, ino: after.ino, mode: after.mode,
        uid: after.uid, gid: after.gid, nlink: after.nlink, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

export async function observeFile(path: string): Promise<FileObservation> {
  const targetPath = await physicalPath(path);
  const file = await readRegularFile(targetPath);
  if (await physicalPath(path) !== targetPath) throw new FilePublicationError("file_changed", `The target's symbolic link changed: ${path}`);
  return { path, targetPath, ...file };
}

export function stagingName(invocationId: string, attempt: number, token: string): string {
  return `.agent-file-${hashBytes(Buffer.from(invocationId)).slice(0, 24)}-${attempt}-${token}.tmp`;
}

export function containsDirectory(ancestor: string, directory: string): boolean {
  const suffix = relative(ancestor, directory);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Capture the established ancestor before mkdir, even if another publisher later creates the chain. */
async function establishedDirectory(parent: string): Promise<DirectoryBoundary> {
  for (let path = parent; ; path = dirname(path)) {
    try {
      const entry = await fs.lstat(path);
      if (!entry.isDirectory()) throw new FilePublicationError("file_changed", `The publication ancestor is not a physical directory: ${path}`);
      return { path, dev: entry.dev, ino: entry.ino };
    } catch (error) {
      if (!hasCode(error, "ENOENT") || dirname(path) === path) throw error;
    }
  }
}

/** Sync child contents before the parent entries that make each child reachable. */
export async function syncPublicationDirectories(targetPath: string, boundary?: DirectoryBoundary, parentHandle?: FileHandle): Promise<void> {
  const parent = dirname(targetPath);
  const stop = boundary?.path ?? parse(parent).root;
  if (!containsDirectory(stop, parent)) throw new FilePublicationError("interrupted", "The durability boundary is outside the target's directory chain.");
  for (let path = parent; ; path = dirname(path)) {
    const retained = path === parent && parentHandle !== undefined;
    const handle = retained ? parentHandle : await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const entry = await fs.lstat(path);
      if (!opened.isDirectory() || !entry.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino
        || (boundary && path === stop && (opened.dev !== boundary.dev || opened.ino !== boundary.ino))) {
        throw new FilePublicationError("interrupted", `The durability directory identity changed: ${path}`);
      }
      await handle.sync();
      const current = await fs.lstat(path);
      if (!current.isDirectory() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new FilePublicationError("interrupted", `The durability directory changed while syncing: ${path}`);
      }
    } finally {
      if (!retained) await handle.close();
    }
    if (path === stop) return;
  }
}

/** Confirm durability of the inspected inode, including an already matching retained file. */
export async function syncObservedFile(source: FileObservation): Promise<void> {
  const expected = source.state;
  if (!expected.exists) throw new FilePublicationError("interrupted", "The recovered target is absent during durability confirmation.");
  const handle = await fs.open(source.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertRegular(opened, source.targetPath);
    if (!sameMetadata(expected, opened)) throw new FilePublicationError("interrupted", "The recovered target changed before file sync.");
    await handle.sync();
    if (!sameMetadata(expected, await handle.stat()) || !sameMetadata(expected, await fs.lstat(source.targetPath))) {
      throw new FilePublicationError("interrupted", "The recovered target changed during file sync.");
    }
  } finally {
    await handle.close();
  }
}

/** Preparation owns memory only, so abandoned plans hold no locks or disk files. */
export async function planFilePublication(source: FileObservation, bytes: Buffer, context: ToolExecutionContext): Promise<FilePublicationPlan> {
  checkFileCancellation(context);
  if (source.state.exists) await fs.access(source.targetPath, constants.W_OK);
  if (context.invocationId !== undefined && (!context.invocationId || context.invocationId.includes("\0"))) {
    throw new FilePublicationError("invalid_arguments", "The invocation identity must be a non-empty string without NUL.");
  }
  const attempt = context.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new FilePublicationError("invalid_arguments", "The attempt must be a positive integer.");
  const token = randomBytes(16).toString("hex");
  const invocationId = context.invocationId ?? `direct:${token}`;
  const directoryBoundary = await establishedDirectory(dirname(source.targetPath));
  checkFileCancellation(context);
  return { source: { ...source, bytes: null }, bytes, afterHash: hashBytes(bytes),
    afterMode: source.state.exists ? source.state.mode & 0o7777 : 0o666 & ~process.umask(),
    cwd: resolve(context.cwd), invocationId: context.invocationId,
    attempt: context.attempt, directoryBoundary,
    staging: { invocationId, attempt, token, relativePath: stagingName(invocationId, attempt, token) } };
}

const publicationQueues = new Map<string, Promise<void>>();

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw new FilePublicationError("cancelled", "The attempt was cancelled while waiting for publication.");
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new FilePublicationError("cancelled", "The attempt was cancelled while waiting for publication."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([previous, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function withFilePublicationLock<T>(path: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const previous = publicationQueues.get(path) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  const tail = previous.then(() => gate);
  publicationQueues.set(path, tail);
  try {
    await waitForTurn(previous, signal);
    return await action();
  } finally {
    release();
    // A cancelled waiter retains the predecessor in the queue until it finishes.
    void tail.then(() => { if (publicationQueues.get(path) === tail) publicationQueues.delete(path); });
  }
}

async function verifySource(source: FileObservation): Promise<void> {
  const current = await observeFile(source.path);
  if (current.targetPath !== source.targetPath || !sameFileState(source.state, current.state)) {
    throw new FilePublicationError("file_changed", `The target differs from the prepared source: ${source.path}`);
  }
  if (current.state.exists) await fs.access(current.targetPath, constants.W_OK);
}

async function cleanupCreatedStage(path: string, created: Stats): Promise<void> {
  let entry: Stats;
  try { entry = await fs.lstat(path); }
  catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  if (!entry.isFile() || entry.nlink !== 1 || entry.dev !== created.dev || entry.ino !== created.ino || entry.birthtimeMs !== created.birthtimeMs) {
    throw new FilePublicationError("interrupted", "The staging identity changed; its path requires inspection.");
  }
  await fs.unlink(path);
}

async function publishFile(plan: FilePublicationPlan, context: ToolExecutionContext): Promise<void> {
  checkFileCancellation(context);
  await verifySource(plan.source);
  const parent = dirname(plan.source.targetPath);
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  let stage: FileHandle | undefined;
  let created: Stats | undefined;
  let closed = false;
  let published = false;
  let renameStarted = false;
  let failure: unknown;
  const stagingPath = resolve(parent, plan.staging.relativePath);
  try {
    const directoryState = await directory.stat();
    checkFileCancellation(context);
    stage = await fs.open(stagingPath, "wx", 0o600);
    created = await stage.stat();
    await stage.writeFile(plan.bytes);
    if (plan.source.state.exists) {
      const before = plan.source.state;
      if (created.uid !== before.uid || created.gid !== before.gid) await stage.chown(before.uid, before.gid);
    }
    await stage.chmod(plan.afterMode);
    await stage.sync();
    await stage.close();
    closed = true;
    const staged = await readRegularFile(stagingPath);
    if (!staged.state.exists || staged.state.dev !== created.dev || staged.state.ino !== created.ino || staged.state.hash !== plan.afterHash
      || (staged.state.mode & 0o7777) !== plan.afterMode || (plan.source.state.exists
        && (staged.state.uid !== plan.source.state.uid || staged.state.gid !== plan.source.state.gid))) {
      throw new FilePublicationError("file_changed", "The prepared staging bytes or identity changed before publication.");
    }
    const currentDirectory = await fs.stat(parent);
    if (directoryState.dev !== currentDirectory.dev || directoryState.ino !== currentDirectory.ino) {
      throw new FilePublicationError("file_changed", "The publication directory changed during staging.");
    }
    await verifySource(plan.source);
    checkFileCancellation(context);
    renameStarted = true;
    await fs.rename(stagingPath, plan.source.targetPath);
    published = true;
    await syncPublicationDirectories(plan.source.targetPath, plan.directoryBoundary, directory);
  } catch (error) {
    failure = renameStarted
      ? new FilePublicationError("interrupted", `${published ? "The file was published; directory durability confirmation failed" : "The publication outcome requires inspection"}: ${error instanceof Error ? error.message : String(error)}`, published)
      : error;
  } finally {
    try {
      if (stage && !closed) await stage.close();
    } catch (error) { failure ??= error; }
    try {
      if (created && !published) await cleanupCreatedStage(stagingPath, created);
      else if (stage && !created) throw new FilePublicationError("interrupted", "The created staging inode could not be inspected; its receipt requires inspection.");
    } catch (error) {
      failure = new FilePublicationError("interrupted", `Staging cleanup requires inspection: ${error instanceof Error ? error.message : String(error)}`, published);
    }
    try { await directory.close(); }
    catch (error) { failure ??= new FilePublicationError(published ? "interrupted" : "write_failed", `Directory close failed: ${String(error)}`, published); }
  }
  if (failure !== undefined) throw failure;
}

export function filePublicationExecution(
  plan: FilePublicationPlan,
  checkpoint: ToolCheckpoint,
  label: string,
  output: string,
  mediaType: string,
): PreparedToolExecution {
  const success = (): ToolResult => ({ ok: true, output, returncode: 0, truncated: false, artifacts: [{ path: plan.source.path,
    operation: plan.source.state.exists ? "updated" : "created", mediaType, byteSize: plan.bytes.length, updatedAt: new Date().toISOString() }] });
  let execution: Promise<ToolResult> | undefined;
  return { kind: "ready", checkpoint, execute(context) {
    if (resolve(context.cwd) !== plan.cwd || context.invocationId !== plan.invocationId || context.attempt !== plan.attempt) {
      return Promise.resolve(fileErrorResult(label, new FilePublicationError("invalid_arguments", "The prepared plan belongs to a different invocation, attempt, or workspace.")));
    }
    execution ??= withFilePublicationLock(plan.source.targetPath, context.signal, async () => {
      await publishFile(plan, context);
      return success();
    }).catch((error: unknown) => {
      const result = fileErrorResult(label, error);
      if (error instanceof FilePublicationError && error.published) result.artifacts = success().artifacts;
      return result;
    });
    return execution;
  } };
}
