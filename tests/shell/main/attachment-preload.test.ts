import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "vite";

test("real Electron preload imports disk-backed and memory Files and serves a managed image preview", { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-preload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(".");
  await build({
    configFile: false, logLevel: "silent",
    build: {
      outDir: join(directory, "preload"), target: "node22", minify: false,
      lib: { entry: join(root, "shell/preload/index.ts"), formats: ["cjs"], fileName: () => "index.cjs" },
      rollupOptions: { external: ["electron"] },
    },
  });
  const pageImport = `(async()=>{
    const file=document.querySelector('#disk').files[0];
    const disk=await window.agentAPI.importAttachments([file]);
    const memory=await window.agentAPI.importAttachments([new File(['local memory text'],'note.txt',{type:'text/plain'})]);
    const image=document.querySelector('img');
    const loaded=new Promise((resolve,reject)=>{image.onload=()=>resolve(true);image.onerror=()=>reject(new Error('Preview load failed'));});
    image.src=disk.attachments[0].previewUrl;
    await loaded;
    return {disk,memory,width:image.naturalWidth};
  })()`;
  const source = `
import { app, BrowserWindow, ipcMain, nativeImage, protocol } from 'electron';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AttachmentStore } from ${JSON.stringify(join(root, "shell/main/attachments/store.ts"))};
import { createAttachmentProcessor } from ${JSON.stringify(join(root, "shell/main/attachments/processors.ts"))};
import { attachmentResourceResponse } from ${JSON.stringify(join(root, "shell/main/attachments/resources.ts"))};
const directory = process.argv[2];
app.setPath('userData', join(directory, 'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'attachment',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const timer = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const path = join(directory, 'disk.png');
  await writeFile(path, nativeImage.createFromBitmap(Buffer.from([0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255]),{width:2,height:2}).toPNG());
  const processor = createAttachmentProcessor({runtimeDirectory:directory,workerPath:'unused',normalizeImage:async(path,out)=>{
    await writeFile(join(out,'image.jpg'),nativeImage.createFromPath(path).toJPEG(85));
    return {text:'Image',images:[{fileName:'image.jpg',mediaType:'image/jpeg',label:'Image'}],previewFile:'image.jpg',truncated:false};
  }});
  const store = new AttachmentStore(join(directory,'assets'),processor);
  const requests=[];
  ipcMain.handle('attachments:import',async(_event,uploads)=>{
    requests.push(uploads.map(upload=>({path:upload.path,name:upload.name,bytes:upload.bytes?.length})));
    return store.import(uploads);
  });
  protocol.handle('attachment',request=>attachmentResourceResponse(store,request));
  const win = new BrowserWindow({show:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,preload:join(directory,'preload/index.cjs')}});
  win.webContents.on('console-message',(_event,details)=>{if(details.level==='error') process.stderr.write(details.message+'\\n');});
  await win.loadFile(join(directory,'page.html'));
  win.webContents.debugger.attach('1.3');
  const {root:document} = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const {nodeId} = await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:document.nodeId,selector:'#disk'});
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[path]});
  const result=await win.webContents.executeJavaScript(${JSON.stringify(pageImport)});
  await rm(path);
  const restarted=new AttachmentStore(join(directory,'assets'),processor);
  const [persisted]=await restarted.resolve([result.disk.attachments[0].attachmentId]);
  result.retained=(await restarted.resolveModelImages(persisted.input)).length===1;
  result.requests=requests;
  process.stdout.write('PRELOAD_ATTACHMENT_RESULT='+JSON.stringify(result)+'\\n');
  clearTimeout(timer);win.destroy();app.quit();
}).catch(error=>{process.stderr.write(String(error.stack??error)+'\\n');app.exit(1);});
`;
  await writeFile(join(directory, "main-fixture.mjs"), source);
  await build({
    configFile: false, logLevel: "silent",
    build: {
      outDir: join(directory, "main"), target: "node22", minify: false,
      lib: { entry: join(directory, "main-fixture.mjs"), formats: ["cjs"], fileName: () => "index.cjs" },
      rollupOptions: { external: (id) => id === "electron" || id.startsWith("node:") },
    },
  });
  await writeFile(join(directory, "page.html"), '<!doctype html><input id="disk" type="file"><img alt="fixture">');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)("electron") as string;
  const { stdout } = await promisify(execFile)(electron, [join(directory, "main/index.cjs"), directory], { env, timeout: 35_000, maxBuffer: 1024 * 1024 });
  const line = stdout.split("\n").find((line) => line.startsWith("PRELOAD_ATTACHMENT_RESULT="));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice("PRELOAD_ATTACHMENT_RESULT=".length));
  assert.deepEqual(result.disk.errors, []);
  assert.deepEqual(result.memory.errors, []);
  assert.equal(result.width, 2);
  assert.equal(result.retained, true);
  assert.equal(result.requests[0][0].path, join(directory, "disk.png"));
  assert.equal(result.requests[1][0].name, "note.txt");
  assert.equal(result.requests[1][0].bytes, 17);
  assert.equal("path" in result.disk.attachments[0], false);
});
