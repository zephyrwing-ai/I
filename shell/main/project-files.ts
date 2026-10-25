import { createHash } from "node:crypto";
import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryRequest,
  ProjectDirectoryResult,
} from "../shared/ipc.js";
import type { ProjectRegistry } from "./project-registry.js";

export const PROJECT_DIRECTORY_PAGE_SIZE = 200;
const MAX_PATH_BYTES = 4_096;
const MAX_CURSOR_BYTES = 16_384;
type ErrorCode = Extract<ProjectDirectoryResult, { ok: false }>["error"];
type EntryKey = Pick<ProjectDirectoryEntry, "name" | "kind">;

interface DirectoryCursor {
  version: string;
  after: EntryKey;
}

class DirectoryError extends Error {
  constructor(message: string, readonly code: ErrorCode) {
    super(message);
    this.name = "DirectoryError";
  }
}

/** Read-only UI directory access, independent of activation and model context scans. */
export class ProjectFilesService {
  constructor(private readonly projects: Pick<ProjectRegistry, "getDescriptor">) {}

  async listProjectDirectory(input: unknown): Promise<ProjectDirectoryResult> {
    try {
      const request = validateRequest(input);
      const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor);
      const descriptor = await this.projects.getDescriptor(request.projectId).catch(() => {
        throw new DirectoryError("The selected project is not registered. Choose a project again.", "not_found");
      });
      const root = descriptor.canonicalPath;
      if (descriptor.projectId !== request.projectId || !root || !isAbsolute(root)) {
        throw new DirectoryError("The project directory has changed. Add the directory again.", "project_changed");
      }

      const before = await directoryState(root, request);
      if (cursor && cursor.version !== before.version) throw staleCursor();
      const entries: ProjectDirectoryEntry[] = [];
      const directory = await opendir(before.path);
      // Stream one directory and retain just a sorted page plus one lookahead.
      for await (const entry of directory) {
        const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
        if (!kind) continue;
        const candidate: ProjectDirectoryEntry = {
          name: entry.name,
          relativePath: request.relativePath ? `${request.relativePath}/${entry.name}` : entry.name,
          kind,
        };
        if (cursor && compareEntries(candidate, cursor.after) <= 0) continue;
        let low = 0;
        let high = entries.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compareEntries(entries[middle]!, candidate) < 0) low = middle + 1;
          else high = middle;
        }
        if (low <= PROJECT_DIRECTORY_PAGE_SIZE) {
          entries.splice(low, 0, candidate);
          if (entries.length > PROJECT_DIRECTORY_PAGE_SIZE + 1) entries.pop();
        }
      }

      // Recheck both containment and directory identity before releasing any names.
      const after = await directoryState(root, request);
      if (before.version !== after.version) {
        throw cursor ? staleCursor() : new DirectoryError("The directory changed while loading. Retry from the first page.", "directory_changed");
      }
      const hasMore = entries.length > PROJECT_DIRECTORY_PAGE_SIZE;
      if (hasMore) entries.pop();
      return {
        ok: true,
        projectId: request.projectId,
        relativePath: request.relativePath,
        entries,
        nextCursor: hasMore ? encodeCursor(before.version, entries[entries.length - 1]!) : null,
      };
    } catch (error) {
      if (error instanceof DirectoryError) return { ok: false, error: error.code, message: error.message };
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return { ok: false, error: "not_found", message: "The directory no longer exists. Refresh its parent directory." };
      if (code === "ENOTDIR") return { ok: false, error: "not_directory", message: "The requested path is not a directory." };
      if (code === "EACCES" || code === "EPERM") return { ok: false, error: "permission_denied", message: "Permission to read this directory is required." };
      if (code === "ELOOP") return { ok: false, error: "symlink_not_allowed", message: "Symbolic links are display-only entries. Choose a directory directly." };
      return { ok: false, error: "read_failed", message: "The directory could not be read. Try again." };
    }
  }
}

function validateRequest(input: unknown): ProjectDirectoryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidRequest();
  const request = input as Partial<ProjectDirectoryRequest>;
  if (typeof request.projectId !== "string" || !request.projectId.trim() || request.projectId.length > 256
    || typeof request.relativePath !== "string" || Buffer.byteLength(request.relativePath) > MAX_PATH_BYTES
    || request.relativePath.includes("\0") || request.relativePath.includes("\\")
    || isAbsolute(request.relativePath) || /^[a-z]:/i.test(request.relativePath)
    || (request.relativePath !== "" && request.relativePath.split("/").some((part) => !part || part === "." || part === ".."))
    || (request.cursor !== undefined && (typeof request.cursor !== "string" || !request.cursor || request.cursor.length > MAX_CURSOR_BYTES))) {
    throw invalidRequest();
  }
  return { projectId: request.projectId, relativePath: request.relativePath, cursor: request.cursor };
}

async function directoryState(root: string, request: ProjectDirectoryRequest): Promise<{ path: string; version: string }> {
  if (await realpath(root) !== root || !(await stat(root)).isDirectory()) {
    throw new DirectoryError("The project directory has changed. Add the directory again.", "project_changed");
  }
  const path = resolve(root, request.relativePath);
  if (!isWithin(root, path)) throw new DirectoryError("The requested path is outside the project.", "outside_project");
  const canonicalPath = await realpath(path);
  if (!isWithin(root, canonicalPath)) throw new DirectoryError("The requested path resolves outside the project.", "outside_project");
  if (canonicalPath !== path) {
    throw new DirectoryError("Symbolic links are display-only entries. Choose a directory directly.", "symlink_not_allowed");
  }
  const info = await stat(path, { bigint: true });
  if (!info.isDirectory()) throw new DirectoryError("The requested path is not a directory.", "not_directory");
  const version = createHash("sha256").update(JSON.stringify([
    request.projectId, root, request.relativePath,
    String(info.dev), String(info.ino), String(info.mtimeNs), String(info.ctimeNs),
  ])).digest("hex");
  return { path, version };
}

function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function compareEntries(left: EntryKey, right: EntryKey): number {
  const priority = Number(right.kind === "directory") - Number(left.kind === "directory");
  // Code-unit order is deterministic across locales and gives case variants a strict order.
  return priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function encodeCursor(version: string, { name, kind }: EntryKey): string {
  return Buffer.from(JSON.stringify({ version, after: { name, kind } })).toString("base64url");
}

function decodeCursor(value: string): DirectoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidRequest();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as DirectoryCursor;
    if (!cursor || !/^[a-f0-9]{64}$/.test(cursor.version) || !cursor.after
      || typeof cursor.after.name !== "string" || !cursor.after.name || Buffer.byteLength(cursor.after.name) > MAX_PATH_BYTES
      || /[/\0]/.test(cursor.after.name) || !["file", "directory", "symlink"].includes(cursor.after.kind)) {
      throw invalidRequest();
    }
    return cursor;
  } catch {
    throw new DirectoryError("The directory cursor is invalid. Retry from the first page.", "invalid_request");
  }
}

function invalidRequest(): DirectoryError {
  return new DirectoryError("Provide a registered project identity and a slash-separated relative directory path.", "invalid_request");
}

function staleCursor(): DirectoryError {
  return new DirectoryError("The directory or page scope has changed. Retry from the first page.", "stale_cursor");
}
