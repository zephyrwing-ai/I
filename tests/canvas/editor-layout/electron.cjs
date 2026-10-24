const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");

app.setPath("userData", process.argv[3]);
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const timeout = setTimeout(() => {
  process.stderr.write("Canvas editor browser regression timed out.\n");
  app.exit(1);
}, 60_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: join(__dirname, "preload.cjs") },
  });
  ipcMain.handle("canvas-fixture:mouse-input", (event, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Canvas fixture input belongs to its main renderer only.");
    }
    if (!input || !["mouseDown", "mouseMove", "mouseUp"].includes(input.type) ||
        !Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.y < 0 ||
        input.x > 1400 || input.y > 900 || typeof input.pressed !== "boolean" ||
        Object.keys(input).some((key) => !["type", "x", "y", "pressed"].includes(key))) {
      throw new Error("Canvas fixture input has invalid mouse coordinates or state.");
    }
    window.webContents.sendInputEvent({
      type: input.type, x: input.x, y: input.y, button: "left", clickCount: 1,
      modifiers: input.pressed ? ["leftButtonDown"] : [],
    });
  });
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  window.webContents.setFrameRate(60);
  await window.loadFile(process.argv[2]);
  const result = await window.webContents.executeJavaScript("window.runCanvasLayoutRegression()").catch((error) => {
    throw new Error(`${error.message}; renderer=${JSON.stringify(errors)}`);
  });
  process.stdout.write(`CANVAS_LAYOUT_RESULTS=${JSON.stringify({ ...result, errors })}\n`);
  clearTimeout(timeout);
  ipcMain.removeHandler("canvas-fixture:mouse-input");
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
