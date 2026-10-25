import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "vite";
import applicationMetadata from "../../../package.json";
import { ProviderStore } from "../../../shell/main/provider-store.js";

const execute = promisify(execFile);
const root = resolve(".");

test("Electron startup reopens local stores across product names and launch directories", { timeout: 60_000 }, async (t) => {
  assert.equal(applicationMetadata.storageIdentity, "I");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "application-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = join(directory, "app-data");
  const development = join(directory, "checkout");
  const installed = join(directory, "Applications", "I.app");
  await Promise.all([dataDirectory, development, installed].map((path) => mkdir(path, { recursive: true })));
  const source = `
import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeApplicationStorage } from ${JSON.stringify(join(root, "shell/main/application-storage.ts"))};
import { UiPreferencesStore } from ${JSON.stringify(join(root, "shell/main/ui-preferences.ts"))};
import { AttachmentStore } from ${JSON.stringify(join(root, "shell/main/attachments/store.ts"))};
import { CanvasDocumentStore } from ${JSON.stringify(join(root, "canvas/persistence/CanvasDocumentStore.ts"))};
app.setName(process.argv[3]);
app.setPath('appData', process.argv[2]);
let profile;
if (process.argv[4] === 'legacy-create') {
  profile = join(app.getPath('appData'), 'agent-studio');
  mkdirSync(profile, {recursive: true});
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
} else {
  try { profile = initializeApplicationStorage(app); }
  catch (error) { process.stderr.write(String(error.stack ?? error)); app.exit(1); }
}
const watchdog = setTimeout(() => app.exit(1), 10000);
app.whenReady().then(async () => {
  const database = new DatabaseSync(join(profile, 'agent-sessions.sqlite'));
  database.exec('CREATE TABLE IF NOT EXISTS evidence (history TEXT, attachmentId TEXT)');
  const attachments = new AttachmentStore(join(profile, 'attachments'), async ({path}) => ({
    text: await readFile(path, 'utf8'), images: [], truncated: false,
  }));
  const canvases = new CanvasDocumentStore(profile);
  const preferences = new UiPreferencesStore(join(profile, 'ui-preferences.json'));
  if (process.argv[4] === 'create' || process.argv[4] === 'legacy-create') {
    const defaults = await preferences.get();
    if (defaults.appearance !== 'system' || defaults.language !== 'en') throw new Error('First launch must create default preferences');
    await preferences.update({appearance: 'dark', language: 'zh-CN'});
    const result = await attachments.import([{name: 'note.txt', bytes: Buffer.from('retained attachment')}]);
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    database.prepare('INSERT INTO evidence VALUES (?, ?)').run('retained history', result.attachments[0].attachmentId);
    const current = await canvases.load('project-a');
    await canvases.save('project-a', {
      elements: [{id: 'text-1', type: 'text', x: 0, y: 0, text: 'retained canvas'}], appState: {}, files: {},
    }, current.version);
    if (process.argv[4] === 'legacy-create') await writeFile(join(profile, 'provider-profiles.json'), JSON.stringify({
      version: 4, profiles: [{providerProfileId: 'provider-a', provider: 'openai', name: 'Provider A', baseURL: 'https://api.example.com/v1',
        encryptedApiKey: 'encrypted-test-fixture', models: [{modelId: 'model-a', modelOptionId: 'model-option-a', displayName: 'Model A', available: true, imported: true, state: 'saved'}]}],
    }), {mode: 0o600});
  }
  const row = database.prepare('SELECT history, attachmentId FROM evidence').get();
  const [attachment] = await attachments.resolve([row.attachmentId]);
  const canvas = await canvases.load('project-a');
  process.stdout.write('STORAGE_RESULT=' + JSON.stringify({
    profile, sessionProfile: app.getPath('sessionData'), identity: app.getName(), history: row.history,
    attachment: await readFile(attachment.path, 'utf8'), canvas: canvas.document.elements[0].text, preferences: await preferences.get(),
  }) + '\\n');
  await attachments.dispose();
  database.close();
  clearTimeout(watchdog);
  app.quit();
}).catch(error => { process.stderr.write(String(error.stack ?? error)); app.exit(1); });
`;
  const entry = join(directory, "entry.mjs");
  await writeFile(entry, source);
  await build({
    configFile: false, logLevel: "silent",
    build: {
      outDir: join(directory, "bundle"), target: "node22", minify: false,
      lib: { entry, formats: ["cjs"], fileName: () => "index.cjs" },
      rollupOptions: { external: (id) => id === "electron" || id.startsWith("node:") },
    },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)("electron") as string;
  const launch = async (name: string, mode: string, cwd: string, override?: string, appData = dataDirectory) => {
    const { stdout } = await execute(electron, [
      join(directory, "bundle/index.cjs"), appData, name, mode,
      ...(override ? [`--user-data-dir=${override}`] : []),
    ], { cwd, env, timeout: 12_000 });
    const line = stdout.split("\n").find((value) => value.startsWith("STORAGE_RESULT="));
    assert.ok(line, stdout);
    return JSON.parse(line.slice("STORAGE_RESULT=".length));
  };
  const expected = {
    profile: join(dataDirectory, applicationMetadata.storageIdentity),
    sessionProfile: join(dataDirectory, applicationMetadata.storageIdentity),
    identity: applicationMetadata.storageIdentity,
    history: "retained history", attachment: "retained attachment", canvas: "retained canvas",
    preferences: { appearance: "dark", language: "zh-CN" },
  };
  assert.deepEqual(await launch("Source launcher", "create", development), expected);
  assert.deepEqual(await launch("I", "restore", installed), expected);
  assert.deepEqual(await launch("Future product name", "restore", directory), expected);
  const override = join(directory, "isolated-profile");
  assert.deepEqual(await launch("I", "create", installed, override), {
    ...expected, profile: override, sessionProfile: override,
  });
  assert.deepEqual(await launch("I", "restore", development), expected);

  const legacyData = join(directory, "legacy-app-data");
  await mkdir(legacyData);
  const legacyProfile = join(legacyData, "agent-studio");
  await launch("Previous application", "legacy-create", development, undefined, legacyData);
  // A running old build must finish its writes before its profile changes location.
  if (process.platform === "darwin") {
    const held = new DatabaseSync(join(legacyProfile, "agent-sessions.sqlite"));
    try {
      await assert.rejects(launch("I", "restore", installed, undefined, legacyData), /Quit the previously running application/);
      assert.ok((await stat(legacyProfile)).isDirectory());
    } finally { held.close(); }
  }
  const upgraded = { ...expected, profile: join(legacyData, "I"), sessionProfile: join(legacyData, "I") };
  assert.deepEqual(await launch("I", "restore", installed, undefined, legacyData), upgraded);
  await assert.rejects(stat(legacyProfile), { code: "ENOENT" });
  const providerPath = join(upgraded.profile, "provider-profiles.json");
  let providers = JSON.parse(await readFile(providerPath, "utf8"));
  assert.equal(providers.profiles[0].providerProfileId, "provider-a");
  assert.equal(providers.profiles[0].models[0].available, true);
  if (process.platform !== "win32") {
    assert.equal("encryptedApiKey" in providers.profiles[0], false);
    const backupPath = join(upgraded.profile, "provider-profiles.before-identity-upgrade.json");
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(backup.profiles[0].encryptedApiKey, "encrypted-test-fixture");
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    const providerStore = new ProviderStore(providerPath, {
      available: () => true, encrypt: () => "new-identity-encrypted-test-fixture", decrypt: () => "replacement-test-fixture",
    });
    const [summary] = await providerStore.list();
    assert.equal(summary.credentialConfigured, false);
    assert.equal(summary.models[0].available, false);
    const restoredProvider = await providerStore.save({
      providerProfileId: summary.providerProfileId, name: summary.name, baseURL: summary.baseURL,
      apiKey: "replacement-test-fixture", models: [{ id: "model-a", displayName: "Model A" }],
    });
    assert.equal(restoredProvider.credentialConfigured, true);
    assert.equal(restoredProvider.models[0].available, true);
    assert.equal(restoredProvider.models[0].modelOptionId, "model-option-a");
    // Once users save a replacement, later launches keep the new encrypted value.
    providers = JSON.parse(await readFile(providerPath, "utf8"));
    assert.equal(providers.profiles[0].encryptedApiKey, "new-identity-encrypted-test-fixture");
  }
  assert.deepEqual(await launch("I", "restore", development, undefined, legacyData), upgraded);
  assert.deepEqual(JSON.parse(await readFile(providerPath, "utf8")), providers);
  await assert.rejects(stat(join(upgraded.profile, "identity-upgrade.pending")), { code: "ENOENT" });

  // An existing I profile remains authoritative when both directories are present.
  await launch("Previous application", "legacy-create", development);
  assert.deepEqual(await launch("I", "restore", installed), expected);
  assert.ok((await stat(join(dataDirectory, "agent-studio"))).isDirectory());
  const isolatedLegacyData = join(directory, "isolated-legacy-app-data");
  await mkdir(isolatedLegacyData);
  await launch("Previous application", "legacy-create", development, undefined, isolatedLegacyData);
  const isolated = join(directory, "explicit-profile");
  await launch("I", "create", installed, isolated, isolatedLegacyData);
  assert.ok((await stat(join(isolatedLegacyData, "agent-studio"))).isDirectory());

  const interruptedData = join(directory, "interrupted-upgrade");
  await mkdir(interruptedData);
  await launch("Previous application", "legacy-create", development, undefined, interruptedData);
  const interruptedProfile = join(interruptedData, "I");
  await rename(join(interruptedData, "agent-studio"), interruptedProfile);
  const pending = join(interruptedProfile, "identity-upgrade.pending");
  await writeFile(pending, "I");
  const interruptedProviders = join(interruptedProfile, "provider-profiles.json");
  const validConfiguration = await readFile(interruptedProviders);
  if (process.platform !== "win32") {
    await writeFile(interruptedProviders, "invalid JSON");
    await assert.rejects(launch("I", "restore", installed, undefined, interruptedData), /JSON/);
    assert.ok((await stat(pending)).isFile());
    await writeFile(interruptedProviders, validConfiguration);
  }
  assert.deepEqual(await launch("I", "restore", installed, undefined, interruptedData), {
    ...expected, profile: interruptedProfile, sessionProfile: interruptedProfile,
  });
  await assert.rejects(stat(pending), { code: "ENOENT" });
});

test("attachment setup shares storage metadata in source and packaged layouts and honors explicit directories", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "application-setup-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = { ...applicationMetadata, name: "renamed-npm-package", productName: "Future product name" };
  const env = { ...process.env };
  delete env.ATTACHMENT_RUNTIME_DIRECTORY;
  delete env.ATTACHMENT_REQUIREMENTS_PATH;
  const directories: string[] = [];
  for (const layout of ["source", "packaged"]) {
    const base = join(directory, layout);
    const script = layout === "source" ? join(base, "scripts/setup-attachments.mjs") : join(base, "Contents/Resources/setup-attachments.mjs");
    const manifest = layout === "source" ? join(base, "package.json") : join(base, "Contents/Resources/app/package.json");
    await Promise.all([mkdir(dirname(script), { recursive: true }), mkdir(dirname(manifest), { recursive: true })]);
    await cp(join(root, "scripts/setup-attachments.mjs"), script);
    await writeFile(manifest, JSON.stringify(metadata));
    const { stdout } = await execute(process.execPath, [script, "--help"], { env });
    const runtime = stdout.split("\n").find((line) => line.startsWith("Runtime directory: "))!;
    assert.ok(runtime);
    assert.ok(runtime.endsWith(join(applicationMetadata.storageIdentity, "attachment-runtime")), runtime);
    directories.push(runtime);
    if (process.platform !== "win32") {
      const requirements = layout === "source" ? join(base, "resources/attachments/requirements.txt") : join(base, "Contents/Resources/resources/attachments/requirements.txt");
      const isolatedRuntime = join(base, "isolated-runtime");
      const python = join(isolatedRuntime, "venv/bin/python");
      const uv = join(base, "uv.cjs");
      await Promise.all([mkdir(dirname(requirements), { recursive: true }), mkdir(dirname(python), { recursive: true })]);
      await writeFile(requirements, "fixture-only-requirements");
      await writeFile(python, `#!${process.execPath}\nprocess.exit(0);\n`);
      await writeFile(uv, `#!${process.execPath}\nconst {readFileSync}=require('node:fs');\nconst path=process.argv[process.argv.indexOf('--requirements')+1];\nif(readFileSync(path,'utf8')!=='fixture-only-requirements')process.exit(1);\nconsole.log('REQUIREMENTS='+path);\n`);
      await Promise.all([chmod(python, 0o755), chmod(uv, 0o755)]);
      const installed = await execute(process.execPath, [script, "--directory", isolatedRuntime, "--skip-models"], {
        env: { ...env, ATTACHMENT_UV_PATH: uv },
      });
      assert.ok(installed.stdout.includes(`REQUIREMENTS=${requirements}\n`), installed.stdout);
    }
  }
  assert.equal(directories[0], directories[1]);
  const standalone = join(directory, "standalone.mjs");
  await cp(join(root, "scripts/setup-attachments.mjs"), standalone);
  const environmentOverride = join(directory, "environment-runtime");
  const explicitOverride = join(directory, "explicit-runtime");
  for (const args of [[], ["--directory", explicitOverride]]) {
    const { stdout } = await execute(process.execPath, [standalone, ...args, "--help"], {
      env: { ...env, ATTACHMENT_RUNTIME_DIRECTORY: environmentOverride },
    });
    assert.ok(stdout.includes(`Runtime directory: ${args.length ? explicitOverride : environmentOverride}\n`));
  }
});
