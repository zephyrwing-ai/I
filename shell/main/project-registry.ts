import type { Dirent } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelMessage } from "../../agent/model/types.js";
import type {
  HistoryRepository,
  Project,
  ProjectContextRecord,
} from "../../agent/memory/index.js";
import type { ProjectDescriptor } from "../shared/ipc.js";

const SCAN_POLICY_VERSION = "tree-v2-prioritized-depth2-dir20-nodes180";
const MAX_CACHE_AGE_MS = 30_000;
const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIRECTORY = 20;
const MAX_TREE_NODES = 180;
const MAX_PROJECT_CONTEXT_CHARS = 6_000;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git", ".hg", ".svn", ".next", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".tox",
  ".turbo", ".venv", ".vite", ".cache", "__pycache__", "build", "coverage", "dist",
  "node_modules", "out", "target", "vendor", "venv",
]);

const PRIORITY_ROOT_FILES = [
  "agents.md", "claude.md", "readme.md", "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml", "makefile",
];

const PRIORITY_DIRECTORIES = [
  "src", "app", "apps", "packages", "lib", "cmd", "internal", "server", "frontend", "backend", "test", "tests", "docs",
];

type OmissionReason = "depth-limit" | "tree-budget" | "unreadable";

interface TreeNode {
  name: string;
  kind: "file" | "directory";
  children?: TreeNode[];
  /** Number of immediate children omitted from this directory listing. */
  omittedEntries?: number;
  /** Why this directory's descendants are not represented. */
  childrenOmittedReason?: OmissionReason;
}

interface ProjectTreeSnapshot {
  schemaVersion: 2;
  root: string;
  maxDepth: number;
  maxEntriesPerDirectory: number;
  maxTotalEntries: number;
  entries: TreeNode[];
  omittedEntries: number;
  treeBudgetReached: boolean;
  unreadable: boolean;
}

interface DirectoryListing {
  entries: Dirent[];
  totalEntries: number;
  unreadable: boolean;
}

interface TreeScanResult {
  entries: TreeNode[];
  omittedEntries: number;
  treeBudgetReached: boolean;
  unreadable: boolean;
}

interface ScanBudget {
  remainingNodes: number;
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
    const cwd = process.cwd();
    return {
      descriptor: { projectId: null, displayName: "Choose folder", canonicalPath: null },
      cwd,
      contextVersion: null,
      projectContext: [{ role: "user", content: formatUnprojectedContext(cwd) }],
    };
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
    const budget = { remainingNodes: MAX_TREE_NODES };
    const scan = await scanTree(project.canonicalPath, 0, budget);
    const snapshot: ProjectTreeSnapshot = {
      schemaVersion: 2,
      root: project.canonicalPath,
      maxDepth: MAX_DEPTH,
      maxEntriesPerDirectory: MAX_ENTRIES_PER_DIRECTORY,
      maxTotalEntries: MAX_TREE_NODES,
      entries: scan.entries,
      omittedEntries: scan.omittedEntries,
      treeBudgetReached: scan.treeBudgetReached,
      unreadable: scan.unreadable,
    };
    const treeJson = JSON.stringify(snapshot);
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

async function readDirectoryEntries(directory: string, depth: number): Promise<DirectoryListing> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return { entries: [], totalEntries: 0, unreadable: true };
  }

  const entries: Dirent[] = [];
  let totalEntries = 0;
  try {
    // Keep only the best candidates in memory while counting visible entries;
    // large build/cache directories are filtered before they are considered.
    for await (const entry of handle) {
      const isDirectory = entry.isDirectory();
      if (isNoisyName(entry.name, isDirectory) || (!isDirectory && !entry.isFile())) continue;
      totalEntries += 1;

      let insertionIndex = entries.findIndex((current) => compareEntries(entry, current, depth) < 0);
      if (insertionIndex < 0) insertionIndex = entries.length;
      if (insertionIndex >= MAX_ENTRIES_PER_DIRECTORY) continue;
      entries.splice(insertionIndex, 0, entry);
      if (entries.length > MAX_ENTRIES_PER_DIRECTORY) entries.pop();
    }
  } catch {
    return { entries, totalEntries, unreadable: true };
  }
  return { entries, totalEntries, unreadable: false };
}

function isNoisyName(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".")) return true;
  if (!isDirectory) return false;
  const normalized = name.toLowerCase();
  return IGNORED_DIRECTORY_NAMES.has(normalized)
    || /^node-compile-cache(?:[-_.].*)?$/i.test(name)
    || /^tsx-\d+$/i.test(name);
}

function compareEntries(left: Dirent, right: Dirent, depth: number): number {
  const priorityDelta = entryPriority(left, depth) - entryPriority(right, depth);
  if (priorityDelta !== 0) return priorityDelta;
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  return leftName.localeCompare(rightName) || left.name.localeCompare(right.name);
}

function entryPriority(entry: Dirent, depth: number): number {
  const normalizedName = entry.name.toLowerCase();
  if (depth === 0 && entry.isFile()) {
    const index = PRIORITY_ROOT_FILES.indexOf(normalizedName);
    if (index >= 0) return index;
  }
  if (entry.isDirectory()) {
    const index = PRIORITY_DIRECTORIES.indexOf(normalizedName);
    return 100 + (index >= 0 ? index : PRIORITY_DIRECTORIES.length);
  }
  return 1_000;
}

async function scanTree(directory: string, depth: number, budget: ScanBudget): Promise<TreeScanResult> {
  const listing = await readDirectoryEntries(directory, depth);
  if (listing.unreadable && listing.entries.length === 0) {
    return { entries: [], omittedEntries: 0, treeBudgetReached: false, unreadable: true };
  }

  const nodesBeforeScan = budget.remainingNodes;
  const selectedCount = Math.min(listing.entries.length, MAX_ENTRIES_PER_DIRECTORY, nodesBeforeScan);
  const selectedEntries = listing.entries.slice(0, selectedCount);
  const omittedEntries = Math.max(0, listing.totalEntries - selectedEntries.length);
  budget.remainingNodes -= selectedEntries.length;
  let treeBudgetReached = listing.totalEntries > selectedEntries.length
    && nodesBeforeScan < Math.min(listing.totalEntries, MAX_ENTRIES_PER_DIRECTORY);
  let unreadable = listing.unreadable;

  const nodes: TreeNode[] = [];
  for (const entry of selectedEntries) {
    const isDirectory = entry.isDirectory();
    const node: TreeNode = { name: entry.name, kind: isDirectory ? "directory" : "file" };
    if (isDirectory) {
      if (depth >= MAX_DEPTH) {
        node.childrenOmittedReason = "depth-limit";
      } else if (budget.remainingNodes <= 0) {
        node.childrenOmittedReason = "tree-budget";
        treeBudgetReached = true;
      } else {
        const children = await scanTree(join(directory, entry.name), depth + 1, budget);
        node.children = children.entries;
        if (children.omittedEntries > 0) node.omittedEntries = children.omittedEntries;
        if (children.unreadable) node.childrenOmittedReason = "unreadable";
        treeBudgetReached ||= children.treeBudgetReached;
        unreadable ||= children.unreadable;
      }
    }
    nodes.push(node);
  }

  return { entries: nodes, omittedEntries, treeBudgetReached, unreadable };
}

function formatProjectContext(project: Project, context: ProjectContextRecord): string {
  const snapshot = parseTreeSnapshot(context.treeJson);
  const header = [
    "<project_context>",
    `Project: ${JSON.stringify(project.displayName)}`,
    `Current working directory: ${JSON.stringify(project.canonicalPath)}`,
    "The selected directory is the working directory for this run.",
    snapshot
      ? `Project map: partial, maximum depth ${snapshot.maxDepth}, ${snapshot.maxEntriesPerDirectory} entries per directory, ${snapshot.maxTotalEntries} total entries.`
      : "Project map: unavailable; use filesystem tools to inspect the selected directory.",
    "Hidden and common generated/cache directories are omitted from this map.",
    "The map contains paths, not file contents. Use filesystem tools when you need details.",
  ];
  const treeLines: string[] = [];
  if (snapshot) {
    if (snapshot.unreadable) treeLines.push("- Some directories could not be listed.");
    appendTreeEntries(snapshot.entries, 0, treeLines);
    if (snapshot.omittedEntries > 0) treeLines.push(`- … ${snapshot.omittedEntries} root entries are outside this bounded map.`);
    if (snapshot.treeBudgetReached) treeLines.push("- Additional paths omitted after reaching the total map limit.");
  }

  const closing = "</project_context>";
  const clippingNotice = "- Additional map lines omitted to fit the context budget; use filesystem tools to explore further.";
  const headerText = header.join("\n");
  const baseSize = headerText.length + closing.length + 2;
  const lineBudget = Math.max(0, MAX_PROJECT_CONTEXT_CHARS - baseSize - clippingNotice.length - 2);
  const visibleTreeLines: string[] = [];
  let usedChars = 0;
  let clipped = false;
  for (const line of treeLines) {
    const cost = line.length + (visibleTreeLines.length > 0 ? 1 : 0);
    if (usedChars + cost > lineBudget) {
      clipped = true;
      break;
    }
    visibleTreeLines.push(line);
    usedChars += cost;
  }
  return [...header, ...visibleTreeLines, ...(clipped ? [clippingNotice] : []), closing].join("\n");
}

function formatUnprojectedContext(cwd: string): string {
  return [
    "<workspace_context>",
    "No project is selected.",
    `Current working directory: ${JSON.stringify(cwd)}`,
    "Filesystem tools are available. Relative paths use this working directory.",
    "No project directory map is attached.",
    "</workspace_context>",
  ].join("\n");
}

function parseTreeSnapshot(treeJson: string): ProjectTreeSnapshot | null {
  try {
    const value = JSON.parse(treeJson) as Partial<ProjectTreeSnapshot>;
    if (value.schemaVersion !== 2 || typeof value.root !== "string" || !Array.isArray(value.entries)) return null;
    return value as ProjectTreeSnapshot;
  } catch {
    return null;
  }
}

function appendTreeEntries(entries: TreeNode[], depth: number, lines: string[]): void {
  for (const entry of entries) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${formatEntryName(entry.name)}${entry.kind === "directory" ? "/" : ""}`);
    if (entry.omittedEntries) lines.push(`${indent}  … ${entry.omittedEntries} immediate entries are outside this bounded map.`);
    if (entry.childrenOmittedReason) {
      const reason = {
        "depth-limit": `Subdirectories beyond depth ${MAX_DEPTH} are omitted.`,
        "tree-budget": "Subdirectory contents are omitted at the total map limit.",
        unreadable: "This directory could not be listed.",
      }[entry.childrenOmittedReason];
      lines.push(`${indent}  [${reason}]`);
    }
    if (entry.children?.length) appendTreeEntries(entry.children, depth + 1, lines);
  }
}

function formatEntryName(name: string): string {
  if (!/[\u0000-\u001f\u007f<>]/.test(name)) return name;
  return JSON.stringify(name).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
