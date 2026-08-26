/**
 * Preload — 通过 contextBridge 暴露一个最小、带类型的 API 给渲染进程。
 * 渲染进程无法直接拿 Node；所有能力都从这里显式透出。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AgentAPI, type AgentEvent, type RunRequest, type RunStartAck } from "../shared/ipc.js";

const api: AgentAPI = {
  run: (req: RunRequest): Promise<RunStartAck> => ipcRenderer.invoke(IPC.run, req),

  stop: (): void => ipcRenderer.send(IPC.stop),

  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectDirectory),

  openPath: (path: string): void => ipcRenderer.send(IPC.openPath, path),

  onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => cb(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld("agentAPI", api);
