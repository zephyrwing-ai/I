import { packager } from "@electron/packager";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = join(root, "node_modules/.cache/macos-app");
const bundleId = "com.i.desktop";
const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
const voiceModelName = "ggml-large-v3-turbo-q5_0.bin";
const voiceModelSha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

async function configuration() {
  if (process.platform !== "darwin") throw new Error("macOS app commands require macOS.");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const name = manifest.productName;
  if (typeof name !== "string" || !name.trim() || basename(name) !== name) {
    throw new Error("package.json must define a valid productName.");
  }
  const electronDirectory = dirname(require.resolve("electron/package.json"));
  const electron = JSON.parse(await readFile(join(electronDirectory, "package.json"), "utf8"));
  const executable = join(electronDirectory, "dist", (await readFile(join(electronDirectory, "path.txt"), "utf8")).trim());
  const iconSource = join(root, "frontend/src/assets/app-icon.png");
  const iconHash = createHash("sha256").update(await readFile(iconSource)).digest("hex");
  return {
    manifest,
    name,
    electronVersion: electron.version,
    executable,
    electronDirectory,
    iconSource,
    iconHash,
    microphoneDescription: "I uses the microphone to transcribe voice input into the Composer draft.",
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function nativeIcon(config) {
  const iconDirectory = join(cache, "icons", config.iconHash);
  const icon = join(iconDirectory, "app.icns");
  if (await exists(icon)) return icon;
  await mkdir(iconDirectory, { recursive: true });
  const temporary = await mkdtemp(join(iconDirectory, "build-"));
  try {
    const iconset = join(temporary, "app.iconset");
    await mkdir(iconset);
    await Promise.all([16, 32, 128, 256, 512].flatMap((size) => [1, 2].map(async (scale) => {
      const pixels = size * scale;
      await runFile("/usr/bin/sips", ["-z", String(pixels), String(pixels), config.iconSource,
        "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
    })));
    const generated = join(temporary, "app.icns");
    await runFile("/usr/bin/iconutil", ["--convert", "icns", "--output", generated, iconset]);
    await rename(generated, icon);
    return icon;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runtimeArchive(config) {
  const directory = join(cache, "electron", `${config.electronVersion}-${process.arch}`);
  const archive = join(directory, `electron-v${config.electronVersion}-darwin-${process.arch}.zip`);
  if (await exists(archive)) return directory;
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, "build-"));
  try {
    const generated = join(temporary, "electron.zip");
    await runFile("/usr/bin/ditto", ["-c", "-k", join(config.electronDirectory, "dist"), generated]);
    await rename(generated, archive);
    return directory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyVoiceResources() {
  const directory = join(root, "resources/whisper");
  const engine = join(directory, "whisper-cli");
  await access(engine, constants.R_OK | constants.X_OK);
  await runFile("/usr/bin/lipo", [engine, "-verify_arch", process.arch === "x64" ? "x86_64" : process.arch]);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, voiceModelName))) hash.update(chunk);
  if (hash.digest("hex") !== voiceModelSha256) {
    throw new Error("The packaged speech model checksum is invalid. Restore resources/whisper from its documented source.");
  }
}

async function nativeOptions(config, includeVoiceResources = true) {
  return {
    name: config.name,
    appBundleId: bundleId,
    electronVersion: config.electronVersion,
    platform: "darwin",
    arch: process.arch,
    icon: await nativeIcon(config),
    electronZipDir: await runtimeArchive(config),
    asar: false,
    extraResource: includeVoiceResources
      ? [join(root, "resources"), join(root, "scripts/setup-attachments.mjs")]
      : [],
    usageDescription: {
      Microphone: config.microphoneDescription,
    },
    // Ad-hoc signing makes generated local apps loadable after native metadata changes.
    osxSign: {
      identity: "-", identityValidation: false, continueOnError: false,
      ignore: ["/resources/whisper/.*\\.bin$"],
    },
  };
}

async function validDevelopmentApp(app) {
  const resources = join(app, "Contents/Resources");
  return await exists(join(app, "Contents/MacOS", basename(app, ".app")))
    && await exists(join(resources, "default_app.asar"))
    && !await exists(join(resources, "app"))
    && !await exists(join(resources, "app.asar"));
}

export async function prepareDevelopmentApp(config) {
  config ??= await configuration();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    format: 4,
    electronVersion: config.electronVersion,
    arch: process.arch,
    productName: config.name,
    version: config.manifest.version,
    iconHash: config.iconHash,
    bundleId,
    microphoneDescription: config.microphoneDescription,
  })).digest("hex");
  const directory = join(cache, "development", fingerprint);
  const app = join(directory, `${config.name}.app`);
  if (await validDevelopmentApp(app)) return app;
  await rm(app, { recursive: true, force: true });
  await mkdir(dirname(directory), { recursive: true });
  const temporary = await mkdtemp(join(dirname(directory), "build-"));
  try {
    const source = join(temporary, "source");
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: config.manifest.name,
      productName: config.name,
      version: config.manifest.version,
      main: "main.cjs",
    }));
    await writeFile(join(source, "main.cjs"), "");
    const [output] = await packager({
      ...await nativeOptions(config, false),
      dir: source,
      out: join(temporary, "output"),
      prune: false,
      afterInitialize: [async ({ buildPath }) => {
        const resources = dirname(buildPath);
        await rm(buildPath, { recursive: true });
        await cp(join(dirname(config.executable), "../Resources/default_app.asar"), join(resources, "default_app.asar"));
      }],
    });
    await mkdir(directory, { recursive: true });
    try {
      await rename(join(output, `${config.name}.app`), app);
    } catch (error) {
      if (!await validDevelopmentApp(app)) throw error;
    }
    return app;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function packageApplication(config) {
  await access(join(root, config.manifest.main), constants.R_OK);
  await verifyVoiceResources();
  const [output] = await packager({
    ...await nativeOptions(config),
    dir: root,
    out: join(root, "dist"),
    overwrite: true,
    prune: true,
    ignore: (path) => {
      if (path === "/canvas" || path === "/canvas/LICENSE") return false;
      if (/^\/node_modules\/\./.test(path)) return true;
      return path !== "" && path !== "/package.json"
        && !/^\/(?:out|node_modules)(?:\/|$)/.test(path);
    },
  });
  const packagedApp = join(output, `${config.name}.app`);
  console.log(packagedApp);
  return packagedApp;
}

async function createDmg(config, appPath) {
  const staging = await mkdtemp(join(root, "dist", "dmg-staging-"));
  try {
    await cp(appPath, join(staging, `${config.name}.app`), { recursive: true, dereference: true });
    await symlink("/Applications", join(staging, "Applications"));
    const output = join(root, "dist", `${config.name}-${config.manifest.version}-${process.arch}.dmg`);
    await runFile("/usr/bin/hdiutil", [
      "create",
      "-volname", config.name,
      "-srcfolder", staging,
      "-ov",
      "-format", "UDZO",
      output,
    ]);
    console.log(output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function startElectronVite(config, mode, arguments_) {
  const app = await prepareDevelopmentApp(config);
  const cli = join(dirname(require.resolve("electron-vite/package.json")), "bin/electron-vite.js");
  const args = [cli, mode, ...(mode === "dev" ? ["--watch"] : []), ...arguments_];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      detached: true,
      env: { ...process.env, ELECTRON_EXEC_PATH: join(app, "Contents/MacOS", config.name) },
    });
    let requestedSignal;
    const send = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const listeners = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => {
      requestedSignal = signal;
      send(signal);
    }]));
    for (const [signal, listener] of listeners) process.on(signal, listener);
    const cleanup = () => {
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      send("SIGTERM");
      if (signal || requestedSignal) process.kill(process.pid, signal || requestedSignal);
      else process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function main() {
  const [mode, ...arguments_] = process.argv.slice(2);
  if (!["dev", "preview", "package", "dmg"].includes(mode)) {
    throw new Error("Usage: node scripts/macos-app.mjs <dev|preview|package|dmg> [electron-vite arguments]");
  }
  const config = await configuration();
  if (mode === "package") await packageApplication(config);
  else if (mode === "dmg") {
    const appPath = await packageApplication(config);
    await createDmg(config, appPath);
  }
  else await startElectronVite(config, mode, arguments_);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
