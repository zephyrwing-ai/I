/**
 * Electron 主进程入口 — 创建窗口、注册 IPC、装配 AgentRunner。
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IPC,
  type DeleteProviderResult,
  type InputAttachmentDescriptor,
  type OpenOutputFileResult,
  type OutputFilePreviewResult,
  type ProviderModelDiscoveryInput,
  type ProviderModelDiscoveryResult,
  type ProviderProfileInput,
  type ProviderProfileSummary,
  type RefreshProviderModelsResult,
  type RunRequest,
  type RunStartAck,
  type SaveProviderResult,
} from "../shared/ipc.js";
import { OutputFileRegistry, validateOutputForOpen } from "./output-files.js";
import { composeTaskWithAttachments, InputAttachmentRegistry } from "./input-attachments.js";
import { ProviderStore } from "./provider-store.js";
import { discoverProviderModels, discoveryErrorResult } from "./provider-model-discovery.js";
import { AgentRunner } from "./runner.js";

const mainProcessDirectory = fileURLToPath(new URL(".", import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "",
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
): void {
  const discoveryControllers = new Map<string, AbortController>();

  ipcMain.handle(IPC.run, async (event, req: RunRequest): Promise<RunStartAck> => {
    try {
      const task = req.task.trim();
      const cwd = req.cwd?.trim() || process.cwd();
      const modelOptionId = req.modelOptionId.trim();
      if (!task) return { ok: false, error: "请输入任务。" };
      if (!modelOptionId) return { ok: false, error: "请选择模型。" };
      const attachments = await inputAttachments.resolve(Array.isArray(req.attachmentIds) ? req.attachmentIds : []);
      const resolved = await providers.resolve(modelOptionId);
      const handle = runner.start({ task: composeTaskWithAttachments(task, attachments), cwd, ...resolved }, (payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.event, payload);
      });
      return { ok: true, runId: handle.runId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IPC.stop, () => {
    runner.stop();
  });

  ipcMain.handle(IPC.listProviderProfiles, async (): Promise<ProviderProfileSummary[]> => {
    return providers.list();
  });

  ipcMain.handle(IPC.discoverProviderModels, async (event, input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult> => {
    if (!input || typeof input.requestId !== "string" || !input.requestId) {
      return { ok: false, error: "invalid_response", message: "模型发现请求缺少有效身份。" };
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
    if (runner.isActive) return { ok: false, error: "unsupported", message: "运行期间不能刷新提供商。" };
    if (typeof providerProfileId !== "string" || !providerProfileId) {
      return { ok: false, error: "invalid_response", message: "缺少提供商身份。" };
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
    if (runner.isActive) return { ok: false, error: "运行期间不能修改提供商。" };
    try {
      return { ok: true, profile: await providers.save(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.deleteProvider, async (_event, providerProfileId: string): Promise<DeleteProviderResult> => {
    if (runner.isActive) return { ok: false, error: "运行期间不能删除提供商。" };
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

  ipcMain.handle(IPC.previewOutputFile, async (_event, runId: string, fileId: string): Promise<OutputFilePreviewResult> => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "invalid_request", message: "缺少输出文件身份。" };
    }
    return outputFiles.preview(runId, fileId);
  });

  ipcMain.handle(IPC.openOutputFile, async (_event, runId: string, fileId: string): Promise<OpenOutputFileResult> => {
    if (typeof runId !== "string" || typeof fileId !== "string" || !runId || !fileId) {
      return { ok: false, error: "缺少输出文件身份。" };
    }
    const record = outputFiles.resolveForOpen(runId, fileId);
    if (!record) return { ok: false, error: "输出文件不存在或已经失效。" };
    const validated = await validateOutputForOpen(record);
    if (!validated.ok) return { ok: false, error: validated.error };
    const error = await shell.openPath(validated.path);
    return error ? { ok: false, error } : { ok: true };
  });
}

app.whenReady().then(() => {
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
  const runner = new AgentRunner((runId, cwd, artifacts) => outputFiles.register(runId, cwd, artifacts));
  registerIpc(runner, providers, outputFiles, inputAttachments);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
