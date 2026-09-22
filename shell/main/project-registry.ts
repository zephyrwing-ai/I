import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelMessage } from "../../agent/model/types.js";
import type {
  HistoryRepository,
  Project,
  ProjectContextRecord,
} from "../../agent/memory/index.js";
import type { ProjectDescriptor } from "../shared/ipc.js";

const SCAN_POLICY_VERSION = "tree-v1-depth2-entries20";
const MAX_CACHE_AGE_MS = 30_000;
const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIRECTORY = 20;
const IGNORED_NAMES = new Set([".git", ".hg", ".svn", ".next", ".pytest_cache", "__pycache__", "build", "coverage", "dist", "node_modules", "out", "target", "venv", ".venv"]);

interface TreeNode {
  name: string;
  kind: "file" | "directory";
  children?: TreeNode[];
  truncated?: number;
}

export interface ActiveProjectContext {
  descriptor: ProjectDescriptor;
  cwd: string;
  contextVersion: string | null;
  projectContext: ModelMessage[];
}

export class ProjectRegistry {
  private activeProjectId: string | null = null;

  constructor(private readonly repository: HistoryRepository) {}

  get activeScope(): string | null {
    return this.activeProjectId;
  }

  async selectPath(path: string): Promise<ActiveProjectContext> {
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error("The selected path is not a directory.");

    let project = await this.repository.getProjectByPath(canonicalPath);
    if (!project) {
      project = await this.repository.createProject({ canonicalPath, displayName: basename(canonicalPath) || canonicalPath });
    }
    await this.repository.touchProject(project.id);
    const context = await this.ensureContext(project);
    this.activeProjectId = project.id;
    return this.toActiveContext(project, context);
  }

  clear(): ActiveProjectContext {
    this.activeProjectId = null;
    return { descriptor: { projectId: null, displayName: "Choose folder", canonicalPath: null }, cwd: process.cwd(), contextVersion: null, projectContext: [] };
  }

  async getActiveContext(): Promise<ActiveProjectContext> {
    if (!this.activeProjectId) return this.clear();
    const project = await this.repository.getProject(this.activeProjectId);
    if (!project) return this.clear();
    const context = await this.ensureContext(project);
    return this.toActiveContext(project, context);
  }

  async markContextDirty(projectId: string | null): Promise<void> {
    if (projectId) await this.repository.markProjectContextDirty(projectId);
  }

  private toActiveContext(project: Project, context: ProjectContextRecord): ActiveProjectContext {
    return {
      descriptor: { projectId: project.id, displayName: project.displayName, canonicalPath: project.canonicalPath },
      cwd: project.canonicalPath,
      contextVersion: context.treeHash,
      projectContext: [{ role: "user", content: formatProjectContext(project, context) }],
    };
  }

  private async ensureContext(project: Project): Promise<ProjectContextRecord> {
    const cached = await this.repository.getProjectContext(project.id);
    if (cached && !cached.dirty && cached.scanPolicyVersion === SCAN_POLICY_VERSION && Date.now() - cached.capturedAt < MAX_CACHE_AGE_MS) return cached;
    const tree = await scanTree(project.canonicalPath, 0);
    const treeJson = JSON.stringify({ root: project.canonicalPath, tree });
    const treeHash = createHash("sha256").update(treeJson).digest("hex");
    return this.repository.saveProjectContext(project.id, {
      treeJson,
      treeHash,
      scanPolicyVersion: SCAN_POLICY_VERSION,
      complete: true,
      dirty: false,
    });
  }
}

async function scanTree(directory: string, depth: number): Promise<TreeNode[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const visible = entries
    .filter((entry) => !IGNORED_NAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const nodes: TreeNode[] = [];
  for (const entry of visible.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, kind: "directory", children: depth < MAX_DEPTH ? await scanTree(join(directory, entry.name), depth + 1) : undefined });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, kind: "file" });
    }
  }
  if (visible.length > MAX_ENTRIES_PER_DIRECTORY) nodes.push({ name: `… ${visible.length - MAX_ENTRIES_PER_DIRECTORY} more entries`, kind: "file", truncated: visible.length - MAX_ENTRIES_PER_DIRECTORY });
  return nodes;
}

function formatProjectContext(project: Project, context: ProjectContextRecord): string {
  return [
    "<project_context>",
    `Project: ${project.displayName}`,
    `Working directory: ${project.canonicalPath}`,
    "The following bounded directory tree is a navigation map. Read file contents with tools when needed.",
    context.treeJson,
    "</project_context>",
  ].join("\n");
}
