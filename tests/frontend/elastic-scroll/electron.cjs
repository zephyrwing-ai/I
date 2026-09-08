const { app, BrowserWindow } = require("electron");

app.setPath("userData", process.argv[3]);
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const timeout = setTimeout(() => {
  process.stderr.write("Elastic scroll browser regression timed out.\n");
  app.exit(1);
}, 25_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 800,
    height: 400,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true },
  });
  window.webContents.setFrameRate(60);
  await window.loadFile(process.argv[2]);
  const results = await window.webContents.executeJavaScript("window.runElasticScrollRegression()");
  process.stdout.write(`ELASTIC_SCROLL_RESULTS=${JSON.stringify(results)}\n`);
  clearTimeout(timeout);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
