import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  selectDirectory: "app:select-directory",
  openPath: "app:open-path"
};
const BASH_TOOL = {
  name: "bash",
  description: "Execute a bash command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" }
    },
    required: ["command"]
  }
};
async function query(config, messages, system) {
  switch (config.provider) {
    case "anthropic": {
      const { queryAnthropic } = await import("./anthropic-BhoVH3X2.js");
      const anthropicMsgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
      return queryAnthropic(anthropicMsgs, system, [BASH_TOOL], config.model);
    }
    case "openai": {
      const { queryOpenAI } = await import("./openai-DwJF_7eT.js");
      const openaiMsgs = [
        { role: "system", content: system },
        ...messages.filter((m) => m.role !== "system").map((m) => ({
          role: m.role,
          content: m.content
        }))
      ];
      return queryOpenAI(openaiMsgs, [BASH_TOOL], {
        model: config.model,
        ...config.openai
      });
    }
    case "google": {
      const { queryGoogle } = await import("./google-BZ3B6sDT.js");
      const geminiMsgs = messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));
      return queryGoogle(geminiMsgs, system, [BASH_TOOL], config.model);
    }
  }
}
const DEFAULT_PROMPT = `You are a coding agent. You can run bash commands.
Reply with:
THOUGHT: <your reasoning>
COMMAND: <bash command>
When done, reply with: DONE: <summary>`;
async function run(task, ops, modelConfig, events = {}, agentConfig = { stepLimit: 20, systemPrompt: DEFAULT_PROMPT }) {
  const messages = [
    { role: "system", content: agentConfig.systemPrompt },
    { role: "user", content: task }
  ];
  const cwd = agentConfig.cwd ?? process.cwd();
  const signal = agentConfig.signal;
  for (let i = 0; i < agentConfig.stepLimit; i++) {
    if (signal?.aborted) {
      const done2 = { status: "error", totalSteps: i };
      events.onAgentDone?.(done2);
      return done2;
    }
    const stepCtx = { stepNumber: i + 1, messageCount: messages.length };
    events.onTurnStart?.(stepCtx);
    const resp = await query(modelConfig, messages, agentConfig.systemPrompt);
    messages.push({ role: "assistant", content: resp.content });
    events.onLlmResponse?.(resp.content, resp.actions, stepCtx);
    if (resp.actions.length === 0) {
      const done2 = { status: "completed", totalSteps: i + 1 };
      events.onAgentDone?.(done2);
      return done2;
    }
    for (const action of resp.actions) {
      events.onActionStart?.(action.command, stepCtx);
      const result = await ops.exec(action.command, cwd, { timeout: 30, signal });
      let outputText = `<returncode>${result.returncode}</returncode>
<output>
${result.output}
</output>`;
      if (result.truncated) {
        outputText += `
<note>输出被截断。完整内容: ${result.fullOutputPath}</note>`;
      }
      messages.push({ role: "user", content: outputText });
      events.onActionDone?.({ stepNumber: i + 1, command: action.command, result });
    }
  }
  const done = { status: "step_limit", totalSteps: agentConfig.stepLimit };
  events.onAgentDone?.(done);
  return done;
}
const MAX_OUTPUT = 1e4;
const TRUNCATE_KEEP = 6e3;
function createLocalBashOps() {
  return {
    async exec(command, cwd, opts) {
      return runWithSpawn(command, cwd, opts);
    }
  };
}
let containerId;
function createDockerBashOps(image = "ubuntu:22.04") {
  return {
    async exec(command, cwd, opts) {
      if (!containerId) {
        containerId = execSync(
          `docker run -d --rm -v "${cwd}:${cwd}" -w "${cwd}" ${image} sleep 2h`,
          { encoding: "utf-8" }
        ).trim();
        console.log(`🐳 容器已启动: ${containerId.slice(0, 12)}`);
        process.on("exit", () => {
          if (containerId) execSync(`docker stop ${containerId}`);
        });
      }
      const escaped = command.replace(/'/g, `'\\''`);
      const dockerCmd = `docker exec ${containerId} bash -c '${escaped}'`;
      return runWithSpawn(dockerCmd, cwd, opts);
    }
  };
}
function runWithSpawn(cmd, cwd, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", cmd], { cwd, timeout: opts.timeout ? opts.timeout * 1e3 : 3e4 });
    const chunks = [];
    let totalBytes = 0;
    child.stdout.on("data", (d) => {
      chunks.push(d.toString());
      totalBytes += d.length;
    });
    child.stderr.on("data", (d) => {
      chunks.push(d.toString());
      totalBytes += d.length;
    });
    opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    child.on("close", (code) => {
      const raw = chunks.join("");
      if (raw.length > MAX_OUTPUT) {
        const dir = mkdtempSync(join(tmpdir(), "ts-agent-"));
        const fullPath = join(dir, "full_output.log");
        writeFileSync(fullPath, raw);
        const tail = raw.slice(-TRUNCATE_KEEP);
        resolve({
          output: tail + `

... 省略前 ${raw.length - TRUNCATE_KEEP} 字符 ...
完整输出: ${fullPath}`,
          returncode: code ?? -1,
          truncated: true,
          fullOutputPath: fullPath
        });
      } else {
        resolve({ output: raw, returncode: code ?? -1, truncated: false });
      }
    });
    child.on("error", (err) => reject(err));
  });
}
const SYSTEM_PROMPT = `You are a coding agent. You can run bash commands.
Reply with:
THOUGHT: <your reasoning>
COMMAND: <bash command>
When done, reply with: DONE: <summary>`;
class AgentRunner {
  controller = new AbortController();
  active = false;
  /**
   * 启动一次运行。emit(channel, payload) 由调用方提供（一般绑到 webContents.send）。
   * 若已有运行在跑则抛错。
   */
  start(req, emit) {
    if (this.active) {
      throw new Error("已有运行正在进行，请先停止当前任务。");
    }
    this.active = true;
    this.controller = new AbortController();
    const runId = randomUUID();
    const events = {
      onTurnStart: (ctx) => emit("agent:event", { type: "turnStart", stepNumber: ctx.stepNumber, messageCount: ctx.messageCount }),
      onLlmResponse: (content, actions, ctx) => emit("agent:event", { type: "llmResponse", stepNumber: ctx.stepNumber, content, actions }),
      onActionStart: (command, ctx) => emit("agent:event", { type: "actionStart", stepNumber: ctx.stepNumber, command }),
      onActionDone: (ctx) => emit("agent:event", {
        type: "actionDone",
        stepNumber: ctx.stepNumber,
        command: ctx.command,
        result: ctx.result
      }),
      onAgentDone: (d) => {
        this.active = false;
        emit("agent:event", { type: "done", status: d.status, totalSteps: d.totalSteps });
      }
    };
    const ops = req.useDocker ? createDockerBashOps() : createLocalBashOps();
    run(
      req.task,
      ops,
      {
        provider: req.provider,
        model: req.model,
        openai: { baseURL: req.baseURL, apiKey: req.apiKey }
      },
      events,
      {
        stepLimit: req.stepLimit,
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        signal: this.controller.signal
      }
    ).catch((err) => {
      this.active = false;
      emit("agent:event", { type: "done", status: "error", totalSteps: 0 });
      console.error("[AgentRunner] run failed:", err);
    });
    return { runId, stop: () => this.controller.abort() };
  }
  stop() {
    if (this.active) {
      this.controller.abort();
    }
  }
}
const __dirname$1 = fileURLToPath(new URL(".", import.meta.url));
const runner = new AgentRunner();
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    title: "Agent Studio",
    show: false,
    webPreferences: {
      preload: join(__dirname$1, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname$1, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => {
    win.show();
  });
  return win;
}
function registerIpc() {
  ipcMain.handle(IPC.run, (event, req) => {
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
  ipcMain.on(IPC.openPath, (_event, filePath) => {
    void shell.openPath(filePath);
  });
  ipcMain.handle(IPC.selectDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
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
