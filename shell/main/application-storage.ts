import type { App } from "electron";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import applicationMetadata from "../../package.json";

const UPGRADE_MARKER = "identity-upgrade.pending";

/** Establish the profile before opening any database, session or application window. */
export function initializeApplicationStorage(app: App): string {
  const { storageIdentity } = applicationMetadata;
  app.setName(storageIdentity);
  const override = app.commandLine.getSwitchValue("user-data-dir");
  const directory = override || join(app.getPath("appData"), storageIdentity);
  if (!override && !existsSync(directory)) {
    // The former name is retained only to locate this one-time upgrade source.
    const previous = join(app.getPath("appData"), "agent-studio");
    if (previous !== directory && existsSync(previous)) {
      assertPreviousProfileIdle(previous);
      writeFileSync(join(previous, UPGRADE_MARKER), storageIdentity, { mode: 0o600 });
      renameSync(previous, directory);
    }
  }
  const marker = join(directory, UPGRADE_MARKER);
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== storageIdentity) throw new Error("The local data upgrade belongs to another application identity.");
    resetMigratedCredentials(directory);
    rmSync(marker, { force: true });
  }
  mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
  return directory;
}

/** Encrypted backups preserve recovery; new credentials are saved with the new OS identity. */
function resetMigratedCredentials(directory: string): void {
  if (process.platform === "win32") return;
  const path = join(directory, "provider-profiles.json");
  if (!existsSync(path)) return;
  const source = readFileSync(path);
  const document = JSON.parse(source.toString("utf8")) as { profiles?: unknown[] };
  if (!Array.isArray(document.profiles)) throw new Error("The provider configuration could not be upgraded.");
  const profiles = document.profiles.filter((profile): profile is Record<string, unknown> => profile !== null && typeof profile === "object" && !Array.isArray(profile));
  if (!profiles.some((profile) => typeof profile.encryptedApiKey === "string")) return;
  const backup = join(directory, "provider-profiles.before-identity-upgrade.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    // Publish a complete, private backup before replacing the active configuration.
    writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
    try { linkSync(temporary, backup); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!readFileSync(backup).equals(source)) throw new Error("The saved provider backup differs from the pending upgrade. Restore the configuration before continuing.");
    }
    rmSync(temporary);
    for (const profile of profiles) delete profile.encryptedApiKey;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertPreviousProfileIdle(directory: string): void {
  const database = join(directory, "agent-sessions.sqlite");
  if (process.platform !== "darwin" || !existsSync(database)) return;
  const result = spawnSync("/usr/sbin/lsof", ["-t", "--", database], { encoding: "utf8", timeout: 5000 });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error("Quit the previously running application, then reopen I to complete the local data upgrade.");
  }
  if (result.status !== 1 || result.stderr.trim() || result.error) {
    throw new Error("The previous data directory could not be checked. Close the application and try opening I again.", { cause: result.error });
  }
}
