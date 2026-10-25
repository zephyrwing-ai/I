import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeUiPreferences, validateUiPreferencesPatch, type UiPreferences } from "../shared/ui-preferences.js";

export class UiPreferencesStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get(legacyPreferences?: UiPreferences): Promise<UiPreferences> {
    return this.serialize(async () => normalizeUiPreferences(await this.read(legacyPreferences)));
  }

  update(input: Partial<UiPreferences>): Promise<UiPreferences> {
    return this.serialize(async () => {
      const patch = validateUiPreferencesPatch(input);
      const document = await this.read();
      const preferences = { ...normalizeUiPreferences(document), ...patch };
      await this.persist({ ...document, ...preferences });
      return preferences;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(legacyPreferences?: UiPreferences): Promise<Record<string, unknown>> {
    try {
      const document: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!document || typeof document !== "object" || Array.isArray(document) || (document as { version?: unknown }).version !== 1) {
        throw new Error("Unsupported interface preferences format.");
      }
      return document as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const document = { version: 1, ...normalizeUiPreferences(legacyPreferences) };
      await this.persist(document);
      return document;
    }
  }

  private async persist(document: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
