const { app, BrowserWindow } = require("electron");

app.setPath("userData", process.argv[3]);
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const timeout = setTimeout(() => {
  process.stderr.write("Canvas editor browser regression timed out.\n");
  app.exit(1);
}, 30_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true },
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
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
