const { app, BrowserWindow, nativeTheme } = require("electron");
const { writeFile } = require("node:fs/promises");
const { verifySettingsNavigation } = require("./settings.cjs");

app.setPath("userData", process.argv[3]);
app.commandLine.appendSwitch("disable-background-timer-throttling");
const timer = setTimeout(() => { process.stderr.write("Project navigation regression timed out.\n"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  nativeTheme.themeSource = "light";
  const window = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: "hiddenInset", webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true } });
  await window.loadFile(process.argv[2]);
  const settings = await verifySettingsNavigation(window);
  const result = await window.webContents.executeJavaScript("window.runProjectNavigationRegression()");
  result.settings = settings;
  window.setContentSize(840, 820);
  await new Promise((resolve) => setTimeout(resolve, 350));
  result.narrow = await window.webContents.executeJavaScript("window.measureProjectNavigationLayout()");
  window.setContentSize(1200, 820);
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (process.argv[4]) await writeFile(process.argv[4], (await window.webContents.capturePage()).toPNG());
  if (process.argv[5]) {
    nativeTheme.themeSource = "dark";
    await new Promise((resolve) => setTimeout(resolve, 150));
    result.dark = await window.webContents.executeJavaScript("window.measureProjectNavigationLayout()");
    await writeFile(process.argv[5], (await window.webContents.capturePage()).toPNG());
  }
  process.stdout.write("PROJECT_NAVIGATION_RESULTS=" + JSON.stringify(result) + "\n");
  clearTimeout(timer);
  window.destroy();
  app.quit();
}).catch((error) => { process.stderr.write((error.stack ?? String(error)) + "\n"); app.exit(1); });
