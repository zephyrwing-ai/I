/**
 * Electron 主进程入口 — 创建窗口、注册 IPC、装配 AgentRunner。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC, type RunRequest } from "../shared/ipc.js";
import { AgentRunner } from "./runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const runner = new AgentRunner();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "Agent Studio",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
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
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // 等页面就绪再显示，避免白屏闪烁；窗口摆放与激活交给 macOS 处理。
  win.once("ready-to-show", () => {
    win.show();
  });

  return win;
}

function registerIpc(): void {
  // 启动一次 agent 运行。返回 { ok, runId } 或 { ok:false, error }。
  ipcMain.handle(IPC.run, (event, req: RunRequest) => {
    try {
      const handle = runner.start(req, (channel, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.webContents.send(channel, payload);
      });
      return { ok: true, runId: handle.runId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.on(IPC.stop, () => {
    runner.stop();
  });

  ipcMain.on(IPC.openPath, (_event, filePath: string) => {
    void shell.openPath(filePath);
  });

  ipcMain.handle(IPC.selectDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
