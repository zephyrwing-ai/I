const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("canvasFixtureInput", (input) =>
  ipcRenderer.invoke("canvas-fixture:mouse-input", input),
);
