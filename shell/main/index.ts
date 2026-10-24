/**
 * Electron 主进程入口 — 创建窗口、注册 IPC、装配 AgentRunner。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, webContents } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import appIconPath from "../../frontend/src/assets/app-icon.png?asset";
import applicationMetadata from "../../package.json";
import {
  IPC,
  type DeleteProviderResult,
  type CanvasContextInput,
  type CanvasEditResult,
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
  type ProjectActionRequest,
  type ProjectActionResult,
  type QuitPreparationResult,
  type RunRequest,
  type RunStartAck,
  type SteerRequest,
  type SteerAck,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResult,
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
import { ProjectRegistry, type ActiveProjectContext } from "./project-registry.js";
import { CanvasContextRegistry } from "../../canvas/context/CanvasContextRegistry.js";
import { CanvasDocumentStore } from "../../canvas/persistence/CanvasDocumentStore.js";
import { CanvasEditBridge, CanvasEditBridgeError } from "./canvas-edit-bridge.js";
import { CanvasCliExecutor } from "./canvas-cli-executor.js";
import { VoiceTranscriptionService, voiceResourcePaths } from "./voice-transcription.js";
import { ApplicationLifecycle, installApplicationLifecycle, registerWindowResources } from "./application-lifecycle.js";
import { QuitPreparation } from "./quit-preparation.js";
import {
  createHistoryRecorder,
  SqliteHistoryRepository,
  type HistoryRecorder,
  type HistoryScope,
} from "../../agent/memory/index.js";

const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));
const { name: storageIdentity, productName } = applicationMetadata;

// 产品展示名与持久化身份分别配置，历史数据和钥匙串沿用同一身份。
app.setName(storageIdentity);
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir")
  || join(app.getPath("appData"), storageIdentity);
mkdirSync(userDataDirectory, { recursive: true });
app.setPath("userData", userDataDirectory);
app.setPath("sessionData", userDataDirectory);

const voicePermissionOwners = new Set<number>();
let voicePermissionsRegistered = false;

function registerVoicePermissions(): void {
  if (voicePermissionsRegistered) return;
  voicePermissionsRegistered = true;
  const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL
    ?? pathToFileURL(join(mainProcessDirectory, "../renderer/index.html")).href);
  const isRendererUrl = (value: string): boolean => {
    try {
      const candidate = new URL(value);
      return candidate.origin === rendererUrl.origin
        && candidate.protocol === rendererUrl.protocol
        && candidate.pathname === rendererUrl.pathname;
    } catch {
      return false;
    }
  };
  const isRenderer = (candidate: Electron.WebContents | null): boolean => (
    candidate !== null && voicePermissionOwners.has(candidate.id)
    && isRendererUrl(candidate.getURL())
  );
  session.defaultSession.setPermissionCheckHandler((owner, permission, _origin, details) => (
    permission === "media" && isRenderer(owner) && details.isMainFrame
    && details.mediaType === "audio" && isRendererUrl(details.requestingUrl ?? "")
  ));
  session.defaultSession.setPermissionRequestHandler((owner, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(permission === "media" && isRenderer(owner) && details.isMainFrame
      && isRendererUrl(details.requestingUrl)
      && mediaTypes?.length === 1 && mediaTypes[0] === "audio");
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: productName,
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

  registerVoicePermissions();

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
  canvasEditBridge: CanvasEditBridge,
  projects: ProjectRegistry,
  historyService: HistoryService,
  getHistoryRecorder: (projectId: HistoryScope) => Promise<HistoryRecorder>,
  releaseHistoryRecorder: (projectId: HistoryScope) => Promise<void>,
  voiceTranscription: VoiceTranscriptionService,
  lifecycle: ApplicationLifecycle,
  quitPreparation: QuitPreparation,
): void {
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => lifecycle.admit(
      () => listener(event, ...args),
      channel === IPC.saveCanvasDocument && quitPreparation.isWaiting(event.sender.id),
    ));
  };
  ipcMain.on(IPC.quitPreparationReady, (event, ready: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender)) quitPreparation.setReady(event.sender.id, ready === true);
  });
  ipcMain.on(IPC.quitPreparationResult, (event, result: QuitPreparationResult) => {
    quitPreparation.complete(event.sender.id, result);
  });
  const discoveryControllers = new Map<string, AbortController>();
  const activatedCanvasProjects = new Set<string | null>([projects.activeScope]);
  let projectScopeOperations: Promise<void> = Promise.resolve();
  const inProjectScope = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = projectScopeOperations.then(operation);
    projectScopeOperations = result.then(() => undefined, () => undefined);
    return result;
  };
  const requireIdleProjectScope = (): void => {
    if (runner.isActive) throw new Error("Choose a project after the current run finishes.");
  };
  const prepareProject = async (active: ActiveProjectContext): Promise<void> => {
    await getHistoryRecorder(active.descriptor.projectId);
  };
  const finishProjectActivation = (active: ActiveProjectContext): ProjectDescriptor => {
    activatedCanvasProjects.add(active.descriptor.projectId);
    canvasContexts.clearAll();
    return active.descriptor;
  };

  handle(IPC.run, (event, req: RunRequest): Promise<RunStartAck> => inProjectScope(async () => {
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
      const inputId = randomUUID();
      const createdAt = Date.now();
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
        initialUserEntryId: inputId,
        initialUserCreatedAt: createdAt,
        ownerWebContentsId: event.sender.id,
        runScopedContext: active.projectContext,
        canvasContexts: resolvedCanvasContexts,
        attachments,
        ...resolved,
      }, (payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.event, payload);
      });
      canvasContexts.consumeMany(canvasContextIds);
      return { ok: true, runId: handle.runId, inputId, createdAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  handle(IPC.steer, async (event, request: SteerRequest): Promise<SteerAck> => {
    try {
      if (!request || typeof request !== "object"
        || typeof request.runId !== "string"
        || typeof request.inputId !== "string"
        || typeof request.task !== "string"
        || (request.projectId !== null && typeof request.projectId !== "string")) {
        return { ok: false, error: "The steering input format is invalid." };
      }
      const accepted = await runner.steer(request, event.sender.id);
      return {
        ok: true,
        runId: accepted.runId,
        projectId: accepted.projectId,
        inputId: accepted.inputId,
        acceptOrder: accepted.acceptOrder,
        acceptedAt: accepted.acceptedAt,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IPC.stop, (event) => {
    runner.stop(event.sender.id);
  });

  handle(IPC.transcribeVoice, async (event, request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> => {
    return voiceTranscription.transcribe(request, event.sender.id);
  });

  ipcMain.on(IPC.cancelVoiceTranscription, (event, requestId: string) => {
    if (typeof requestId === "string") voiceTranscription.cancel(requestId, event.sender.id);
  });

  handle(IPC.loadHistoryPage, async (_event, request: HistoryPageRequest): Promise<HistoryPageResult> => {
    return historyService.loadPage(request);
  });

  handle(IPC.getActiveProject, (): Promise<ProjectDescriptor> => inProjectScope(async () => (
    (await projects.getActiveContext()).descriptor
  )));

  handle(IPC.listProjects, (): Promise<ProjectDescriptor[]> => projects.list());

  handle(IPC.activateProject, (_event, projectId: string): Promise<ProjectDescriptor> => inProjectScope(async () => {
    requireIdleProjectScope();
    return finishProjectActivation(await projects.activate(projectId, prepareProject));
  }));

  handle(IPC.performProjectAction, (event, request: ProjectActionRequest): Promise<ProjectActionResult> => inProjectScope(async () => {
    if (!request || typeof request.projectId !== "string" || !["pin", "unpin", "reveal", "rename", "delete"].includes(request.action)) {
      throw new Error("The project action is invalid.");
    }
    if (request.action !== "reveal") requireIdleProjectScope();
    const project = await projects.getDescriptor(request.projectId);
    let status: ProjectActionResult["status"] = "completed";
    switch (request.action) {
      case "pin":
      case "unpin":
        await projects.update(request.projectId, { pinned: request.action === "pin" });
        break;
      case "rename":
        if (typeof request.name !== "string") throw new Error("Enter a project display name.");
        await projects.update(request.projectId, { displayName: request.name });
        break;
      case "reveal":
        shell.showItemInFolder(project.canonicalPath!);
        break;
      case "delete": {
        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
        const options = {
          type: "warning" as const,
          buttons: ["Cancel", "Delete session"],
          defaultId: 0,
          cancelId: 0,
          message: `Delete “${project.displayName}”?`,
          detail: "The project registration and its chat history will be deleted. Your project folder and files will remain on disk.",
        };
        const confirmation = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        if (confirmation.response !== 1) {
          status = "cancelled";
          break;
        }
        const deletingActiveProject = projects.activeScope === request.projectId;
        if (deletingActiveProject) await getHistoryRecorder(null);
        await releaseHistoryRecorder(request.projectId);
        await projects.delete(request.projectId);
        activatedCanvasProjects.delete(request.projectId);
        if (deletingActiveProject) {
          activatedCanvasProjects.add(null);
          canvasContexts.clearAll();
        }
        break;
      }
    }
    const changed = status === "completed" && request.action !== "reveal";
    return { status, ...(changed ? { projects: await projects.list() } : {}), activeProject: await projects.getActiveDescriptor() };
  }));

  handle(IPC.selectProject, async (event): Promise<ProjectDescriptor | null> => {
    requireIdleProjectScope();
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) throw new Error("The project folder picker has no available application window.");
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return inProjectScope(async () => {
      requireIdleProjectScope();
      return finishProjectActivation(await projects.selectPath(result.filePaths[0]!, prepareProject));
    });
  });

  handle(IPC.clearProject, (): Promise<ProjectDescriptor> => inProjectScope(async () => {
    requireIdleProjectScope();
    await getHistoryRecorder(null);
    return finishProjectActivation(projects.clear());
  }));

  handle(IPC.listProviderProfiles, async (): Promise<ProviderProfileSummary[]> => {
    return providers.list();
  });

  handle(IPC.discoverProviderModels, async (event, input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult> => {
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

  handle(IPC.refreshProviderModels, async (_event, providerProfileId: string): Promise<RefreshProviderModelsResult> => {
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

  handle(IPC.saveProvider, async (_event, input: ProviderProfileInput): Promise<SaveProviderResult> => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be changed while a run is active." };
    try {
      return { ok: true, profile: await providers.save(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handle(IPC.deleteProvider, async (_event, providerProfileId: string): Promise<DeleteProviderResult> => {
    if (runner.isActive) return { ok: false, error: "Providers cannot be deleted while a run is active." };
    try {
      await providers.delete(providerProfileId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handle(IPC.selectAttachments, async (event): Promise<InputAttachmentDescriptor[]> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return result.canceled ? [] : inputAttachments.register(result.filePaths);
  });

  handle(IPC.loadCanvasDocument, async (_event, projectId: string | null): Promise<CanvasDocumentResult> => {
    if (projectId !== projects.activeScope) throw new Error("The selected project changed. Open the canvas again.");
    return canvasDocuments.load(projectId);
  });

  handle(IPC.saveCanvasDocument, async (_event, request: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    if (!request || !activatedCanvasProjects.has(request.projectId)) {
      throw new Error("The canvas project identity is invalid.");
    }
    return canvasDocuments.save(request.projectId, request.document, request.expectedVersion);
  });

  handle(IPC.prepareCanvasContext, async (_event, input: CanvasContextInput) => {
    if (!input || input.projectId !== projects.activeScope) {
      throw new Error("The selected project changed. Select the canvas content again.");
    }
    return canvasContexts.prepare(input);
  });

  ipcMain.on(IPC.canvasEditResult, (event, result: CanvasEditResult) => {
    canvasEditBridge.handleResult(event.sender.id, result);
  });

  handle(IPC.previewOutputFile, async (_event, runId: string, fileId: string): Promise<OutputFilePreviewResult> => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "invalid_request", message: "The output file identity is missing." };
    }
    return outputFiles.preview(runId, fileId);
  });

  handle(IPC.openOutputFile, async (_event, runId: string, fileId: string): Promise<OpenOutputFileResult> => {
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
  app.setAboutPanelOptions({ applicationName: productName });
  if (process.platform === "darwin") {
    app.dock?.setIcon(appIconPath);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: productName,
        submenu: [
          { role: "about", label: `About ${productName}` },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${productName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${productName}` },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]));
  }

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
  const releaseHistoryRecorder = async (projectId: HistoryScope): Promise<void> => {
    const key = recorderKey(projectId);
    await recorders.get(key)?.close();
    recorders.delete(key);
  };
  await getHistoryRecorder(null);

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
  const canvasEditBridge = new CanvasEditBridge({
    sendRequest(ownerWebContentsId, request) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (!owner || owner.isDestroyed()) return false;
      owner.send(IPC.canvasEditRequest, request);
      return true;
    },
    sendCancel(ownerWebContentsId, request) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (owner && !owner.isDestroyed()) owner.send(IPC.canvasEditCancel, request);
    },
    onOwnerDestroyed(ownerWebContentsId, callback) {
      const owner = webContents.fromId(ownerWebContentsId);
      if (!owner || owner.isDestroyed()) {
        callback();
        return () => undefined;
      }
      owner.once("destroyed", callback);
      return () => owner.removeListener("destroyed", callback);
    },
  });
  const canvasCli = new CanvasCliExecutor((ownerWebContentsId, request, signal) => {
    if (projects.activeScope !== request.projectId) {
      throw new CanvasEditBridgeError("canvas_unavailable", "The Canvas project changed before the edit could be applied.");
    }
    return canvasEditBridge.request(ownerWebContentsId, request, signal);
  });
  const runner = new AgentRunner((runId, cwd, artifacts, projectId) => {
    void projects.markContextDirty(projectId);
    return outputFiles.register(runId, cwd, artifacts);
  }, {
    enableCreateWithoutSelection: true,
    execute: (ownerWebContentsId, request, signal) => canvasCli.execute(ownerWebContentsId, request, signal),
  });
  const voiceTranscription = new VoiceTranscriptionService(voiceResourcePaths({
    isPackaged: app.isPackaged,
    defaultApp: process.defaultApp,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }));
  const quitPreparation = new QuitPreparation();
  const lifecycle = new ApplicationLifecycle({
    prepare: async () => {
      runner.stop();
      for (const window of BrowserWindow.getAllWindows()) voiceTranscription.cancelOwner(window.webContents.id);
      // Admitted project changes settle before the renderer flushes its current scope.
      await lifecycle.waitForRequests();
      runner.stop();
      await runner.waitForIdle();
      await quitPreparation.flush(BrowserWindow.getAllWindows().map((window) => ({
        id: window.webContents.id,
        send: (requestId: string) => window.webContents.send(IPC.prepareToQuit, { requestId }),
      })));
    },
    drain: async () => {
      canvasCli.dispose();
      canvasEditBridge.dispose();
      await voiceTranscription.dispose();
      await canvasDocuments.waitForIdle();
      await Promise.all([...recorders.values()].map((recorder) => recorder.close()));
    },
    close: () => historyRepository.close(),
    exit: (code) => app.exit(code),
    onError: (error) => {
      if (lifecycle.phase === "running") {
        dialog.showErrorBox("Changes could not be saved", error instanceof Error ? error.message : String(error));
      } else console.error("Application shutdown failed", error);
    },
  });
  const openWindow = (): void => {
    const window = createWindow();
    registerWindowResources(window, { voicePermissionOwners, quitPreparation, voiceTranscription });
  };
  registerIpc(runner, providers, outputFiles, inputAttachments, canvasContexts, canvasDocuments, canvasEditBridge, projects, historyService, getHistoryRecorder, releaseHistoryRecorder, voiceTranscription, lifecycle, quitPreparation);
  installApplicationLifecycle(app, process, lifecycle, {
    hasOpenWindows: () => BrowserWindow.getAllWindows().length > 0,
    create: openWindow,
    platform: process.platform,
  });
  openWindow();
}).catch((error: unknown) => {
  dialog.showErrorBox("History storage initialization failed", error instanceof Error ? error.message : String(error));
  app.quit();
});
