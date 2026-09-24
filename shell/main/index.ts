/**
 * Electron 主进程入口 — 创建窗口、注册 IPC、装配 AgentRunner。
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  IPC,
  type DeleteProviderResult,
  type CanvasContextInput,
  type CanvasDocumentResult,
  type CanvasSaveRequest,
  type CanvasSaveResult,
  type InputAttachmentDescriptor,
  type OpenOutputFileResult,
  type OutputFilePreviewResult,
  type ProviderModelDiscoveryInput,
  type ProviderModelDiscoveryResult,
  type ProviderProfileInput,
  type ProviderProfileSummary,
  type RefreshProviderModelsResult,
  type ProjectDescriptor,
  type RunRequest,
  type RunStartAck,
  type SaveProviderResult,
  type HistoryPageRequest,
  type HistoryPageResult,
} from "../shared/ipc.js";
import { OutputFileRegistry, validateOutputForOpen } from "./output-files.js";
import { composeTaskWithAttachments, InputAttachmentRegistry } from "./input-attachments.js";
import { ProviderStore } from "./provider-store.js";
import { discoverProviderModels, discoveryErrorResult } from "./provider-model-discovery.js";
import { AgentRunner } from "./runner.js";
import { HistoryService } from "./session-history.js";
import { ProjectRegistry } from "./project-registry.js";
import { CanvasContextRegistry } from "../../canvas/context/CanvasContextRegistry.js";
import { CanvasDocumentStore } from "../../canvas/persistence/CanvasDocumentStore.js";
import {
  createHistoryRecorder,
  SqliteHistoryRepository,
  type HistoryRecorder,
  type HistoryScope,
} from "../../agent/memory/index.js";

const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 20 },
    show: false,
    webPreferences: {
      preload: join(mainProcessDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 渲染进程里的外链一律走系统浏览器，不打开新 Electron 窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(mainProcessDirectory, "../renderer/index.html"));
  }

  // 等页面就绪再显示，避免白屏闪烁；窗口摆放与激活交给 macOS 处理。
  win.once("ready-to-show", () => {
    win.show();
  });

  return win;
}

function registerIpc(
  runner: AgentRunner,
  providers: ProviderStore,
  outputFiles: OutputFileRegistry,
  inputAttachments: InputAttachmentRegistry,
  canvasContexts: CanvasContextRegistry,
  canvasDocuments: CanvasDocumentStore,
  projects: ProjectRegistry,
  historyService: HistoryService,
  getHistoryRecorder: (projectId: HistoryScope) => Promise<HistoryRecorder>,
): void {
  const discoveryControllers = new Map<string, AbortController>();
  const activatedCanvasProjects = new Set<string | null>([projects.activeScope]);

  ipcMain.handle(IPC.run, async (event, req: RunRequest): Promise<RunStartAck> => {
    try {
      const task = req.task.trim();
      const active = await projects.getActiveContext();
      const projectId = projects.activeScope;
      if (req.projectId !== undefined && req.projectId !== projectId) return { ok: false, error: "The selected project changed. Choose the project again." };
      const cwd = active.cwd;
      const modelOptionId = req.modelOptionId.trim();
      if (!task) return { ok: false, error: "Enter a task." };
      if (!modelOptionId) return { ok: false, error: "Choose a model." };
      const attachments = await inputAttachments.resolve(Array.isArray(req.attachmentIds) ? req.attachmentIds : []);
      const resolved = await providers.resolve(modelOptionId);
      const runId = randomUUID();
      const canvasContextIds = Array.isArray(req.canvasContextIds) ? req.canvasContextIds.filter((id): id is string => typeof id === "string") : [];
      const resolvedCanvasContexts = canvasContexts.peekMany(canvasContextIds, projectId);
      const historyRecorder = await getHistoryRecorder(projectId);
      if (projects.activeScope !== projectId) {
        return { ok: false, error: "The selected project changed. Send the task again." };
      }
      const handle = runner.start({
        task: composeTaskWithAttachments(task, attachments),
        cwd,
        projectId,
        projectContextVersion: active.contextVersion,
        historyRecorder,
        runId,
        runScopedContext: active.projectContext,
        canvasContexts: resolvedCanvasContexts,
        ...resolved,
      }, (payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.event, payload);
      });
      canvasContexts.consumeMany(canvasContextIds);
      return { ok: true, runId: handle.runId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IPC.stop, () => {
    runner.stop();
  });

  ipcMain.handle(IPC.loadHistoryPage, async (_event, request: HistoryPageRequest): Promise<HistoryPageResult> => {
    return historyService.loadPage(request);
  });

  ipcMain.handle(IPC.getActiveProject, async (): Promise<ProjectDescriptor> => {
    return (await projects.getActiveContext()).descriptor;
  });

  ipcMain.handle(IPC.selectProject, async (event): Promise<ProjectDescriptor | null> => {
    if (runner.isActive) throw new Error("Choose a project after the current run finishes.");
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const active = await projects.selectPath(result.filePaths[0]!);
    activatedCanvasProjects.add(active.descriptor.projectId);
    canvasContexts.clearAll();
    await getHistoryRecorder(active.descriptor.projectId);
    return active.descriptor;
  });

  ipcMain.handle(IPC.clearProject, async (): Promise<ProjectDescriptor> => {
    if (runner.isActive) throw new Error("Clear the project after the current run finishes.");
    const active = projects.clear();
    canvasContexts.clearAll();
    await getHistoryRecorder(null);
    return active.descriptor;
  });

  ipcMain.handle(IPC.listProviderProfiles, async (): Promise<ProviderProfileSummary[]> => {
    return providers.list();
  });

  ipcMain.handle(IPC.discoverProviderModels, async (event, input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult> => {
    if (!input || typeof input.requestId !== "string" || !input.requestId) {
      return { ok: false, error: "invalid_response", message: "The model discovery request is missing a valid identity." };
    }
    const requestKey = `${event.sender.id}:${input.requestId}`;
    discoveryControllers.get(requestKey)?.abort();
    const controller = new AbortController();
    discoveryControllers.set(requestKey, controller);
    const abortOnDestroyed = (): void => controller.abort();
    event.sender.once("destroyed", abortOnDestroyed);
    try {
      const connection = await providers.discoveryConnection(input);
      const models = await discoverProviderModels(connection, { signal: controller.signal });
      return { ok: true, models };
    } catch (error) {
      return discoveryErrorResult(error);
    } finally {
      event.sender.removeListener("destroyed", abortOnDestroyed);
      if (discoveryControllers.get(requestKey) === controller) discoveryControllers.delete(requestKey);
    }
  });

  ipcMain.on(IPC.cancelProviderModelDiscovery, (event, requestId: string) => {
    if (typeof requestId !== "string" || !requestId) return;
    discoveryControllers.get(`${event.sender.id}:${requestId}`)?.abort();
  });

  ipcMain.handle(IPC.refreshProviderModels, async (_event, providerProfileId: string): Promise<RefreshProviderModelsResult> => {
    if (runner.isActive) return { ok: false, error: "unsupported", message: "Providers cannot be refreshed while a run is active." };
    if (typeof providerProfileId !== "string" || !providerProfileId) {
      return { ok: false, error: "invalid_response", message: "The provider identity is missing." };
    }
    try {
      const connection = await providers.refreshConnection(providerProfileId);
      const models = await discoverProviderModels(connection);
      return { ok: true, profile: await providers.applyRefresh(providerProfileId, models) };
    } catch (error) {
      return discoveryErrorResult(error);
    }
  });

  ipcMain.handle(IPC.saveProvider, async (_event, input: ProviderProfileInput): Promise<SaveProviderResult> => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be changed while a run is active." };
    try {
      return { ok: true, profile: await providers.save(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.deleteProvider, async (_event, providerProfileId: string): Promise<DeleteProviderResult> => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be deleted while a run is active." };
    try {
      await providers.delete(providerProfileId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.selectAttachments, async (event): Promise<InputAttachmentDescriptor[]> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return result.canceled ? [] : inputAttachments.register(result.filePaths);
  });

  ipcMain.handle(IPC.loadCanvasDocument, async (_event, projectId: string | null): Promise<CanvasDocumentResult> => {
    if (projectId !== projects.activeScope) throw new Error("The selected project changed. Open the canvas again.");
    return canvasDocuments.load(projectId);
  });

  ipcMain.handle(IPC.saveCanvasDocument, async (_event, request: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    if (!request || !activatedCanvasProjects.has(request.projectId)) {
      throw new Error("The canvas project identity is invalid.");
    }
    return { revision: await canvasDocuments.save(request.projectId, request.document) };
  });

  ipcMain.handle(IPC.prepareCanvasContext, async (_event, input: CanvasContextInput) => {
    if (!input || input.projectId !== projects.activeScope) {
      throw new Error("The selected project changed. Select the canvas content again.");
    }
    return canvasContexts.prepare(input);
  });

  ipcMain.handle(IPC.previewOutputFile, async (_event, runId: string, fileId: string): Promise<OutputFilePreviewResult> => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "invalid_request", message: "The output file identity is missing." };
    }
    return outputFiles.preview(runId, fileId);
  });

  ipcMain.handle(IPC.openOutputFile, async (_event, runId: string, fileId: string): Promise<OpenOutputFileResult> => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "The output file identity is missing." };
    }
    const record = outputFiles.resolveForOpen(runId, fileId);
    if (!record) return { ok: false, error: "The output file does not exist or is no longer valid." };
    const validated = await validateOutputForOpen(record);
    if (!validated.ok) return { ok: false, error: validated.error };
    const error = await shell.openPath(validated.path);
    return error ? { ok: false, error } : { ok: true };
  });
}

app.whenReady().then(async () => {
  const historyRepository = new SqliteHistoryRepository(join(app.getPath("userData"), "agent-sessions.sqlite"));
  const projects = new ProjectRegistry(historyRepository);
  const historyService = new HistoryService(() => projects.activeScope, historyRepository);
  const recorders = new Map<string, HistoryRecorder>();
  const recorderKey = (projectId: HistoryScope): string => projectId ?? "__unprojected__";
  const getHistoryRecorder = async (projectId: HistoryScope): Promise<HistoryRecorder> => {
    const key = recorderKey(projectId);
    const existing = recorders.get(key);
    if (existing) return existing;
    const recorder = await createHistoryRecorder(historyRepository, projectId);
    recorders.set(key, recorder);
    return recorder;
  };
  await getHistoryRecorder(null);
  let closing = false;

  const providers = new ProviderStore(
    join(app.getPath("userData"), "provider-profiles.json"),
    {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (secret) => safeStorage.encryptString(secret).toString("base64"),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, "base64")),
    },
  );
  const outputFiles = new OutputFileRegistry();
  const inputAttachments = new InputAttachmentRegistry();
  const canvasDocuments = new CanvasDocumentStore(app.getPath("userData"));
  const canvasContexts = new CanvasContextRegistry();
  const runner = new AgentRunner((runId, cwd, artifacts, projectId) => {
    void projects.markContextDirty(projectId);
    return outputFiles.register(runId, cwd, artifacts);
  });
  registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, canvasDocuments, projects, historyService, getHistoryRecorder);
  createWindow();

  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    runner.stop();
    void (async () => {
      try {
        await runner.waitForIdle();
        await canvasDocuments.waitForIdle();
        await Promise.all([...recorders.values()].map((recorder) => recorder.close()));
      } finally {
        historyRepository.close();
        app.quit();
      }
    })();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  dialog.showErrorBox("History storage initialization failed", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
