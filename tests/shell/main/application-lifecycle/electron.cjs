const { app, BrowserWindow, ipcMain } = require("electron");
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
const { ApplicationLifecycle, installApplicationLifecycle, QuitPreparation } = require(process.argv[2]);
const profile = process.argv[3];
const mode = process.argv[4];
app.setPath("userData", profile);
const database = new DatabaseSync(join(profile, "history.sqlite"));
database.exec("CREATE TABLE saved(value TEXT)");
let closes = 0;
let reopened = false;
let rejected = false;
let window;
const watchdog = setTimeout(() => { process.stderr.write(`Lifecycle fixture timed out: ${mode}\n`); app.exit(1); }, 10000);

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL("data:text/html,lifecycle");
  if (mode === "legacy-cancelled-quit") {
    await window.webContents.executeJavaScript("window.onbeforeunload = () => false; void 0");
    let closing = false;
    app.on("before-quit", (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      setImmediate(() => { database.close(); app.quit(); });
    });
    app.quit();
    setTimeout(() => {
      let error = "";
      try { database.prepare("SELECT 1"); } catch (failure) { error = failure.message; }
      process.stdout.write(`LIFECYCLE_RESULT=${JSON.stringify({ stillOpen: !window.isDestroyed(), error })}\n`);
      clearTimeout(watchdog);
      app.exit(0);
    }, 300);
    return;
  }

  const preparation = new QuitPreparation(2000);
  preparation.setReady(window.webContents.id, true);
  ipcMain.on("prepared", (event, result) => preparation.complete(event.sender.id, result));
  const lifecycle = new ApplicationLifecycle({
    prepare: async () => {
      try { await lifecycle.admit(() => database.prepare("SELECT 1").get()); }
      catch (error) { rejected = error.message.includes("preparing to quit"); }
      await lifecycle.waitForRequests();
      await preparation.flush(BrowserWindow.getAllWindows().map((owner) => ({
        id: owner.webContents.id,
        send: (requestId) => owner.webContents.send("prepare", { requestId }),
      })));
    },
    drain: async () => undefined,
    close: () => {
      const saved = database.prepare("SELECT value FROM saved ORDER BY rowid").all().map((row) => row.value);
      database.close();
      closes += 1;
      process.stdout.write(`LIFECYCLE_RESULT=${JSON.stringify({ closes, rejected, reopened, saved, phase: lifecycle.phase })}\n`);
    },
    exit: (code) => { clearTimeout(watchdog); app.exit(code); },
    onError: (error) => { process.stderr.write(String(error.stack ?? error)); app.exit(1); },
  });
  ipcMain.handle("save-draft", (event, value) => lifecycle.admit(() => {
    database.prepare("INSERT INTO saved(value) VALUES (?)").run(value);
  }, preparation.isWaiting(event.sender.id)));
  installApplicationLifecycle(app, process, lifecycle, {
    platform: "darwin",
    hasOpenWindows: () => BrowserWindow.getAllWindows().length > 0,
    create: () => {
      database.prepare("SELECT 1").get();
      window = new BrowserWindow({ show: false });
      reopened = true;
    },
  });
  const originalOwnerId = window.webContents.id;
  window.webContents.once("destroyed", () => preparation.removeOwner(originalOwnerId));
  await window.webContents.executeJavaScript(`
    const {ipcRenderer} = require('electron');
    ipcRenderer.on('prepare', async (_event, request) => {
      await ipcRenderer.invoke('save-draft', 'renderer draft');
      ipcRenderer.send('prepared', request);
    });
    window.onbeforeunload = () => false;
    void 0;
  `);
  if (mode === "close-and-reactivate") {
    await window.webContents.executeJavaScript("window.onbeforeunload = null");
    window.destroy();
    if (lifecycle.phase !== "running") throw new Error("Window close started service teardown");
    app.emit("activate");
    if (!reopened) throw new Error("Activation failed to reopen the window");
  }
  // An operation admitted before quit must finish before storage is closed.
  void lifecycle.admit(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    database.prepare("INSERT INTO saved(value) VALUES ('admitted write')").run();
  });
  if (mode === "signal") process.kill(process.pid, "SIGTERM");
  else app.quit();
}).catch((error) => { process.stderr.write(String(error.stack ?? error)); app.exit(1); });
