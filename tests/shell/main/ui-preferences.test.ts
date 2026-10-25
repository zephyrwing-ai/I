import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { UiPreferencesStore } from "../../../shell/main/ui-preferences.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ui-preferences-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "profile", "ui-preferences.json");
  return { directory, file, store: new UiPreferencesStore(file) };
}

test("first launch creates private defaults and a fresh store restores saved choices", async t => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.get(), { appearance: "system", language: "en" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, appearance: "system", language: "en" });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await Promise.all([store.update({ appearance: "dark" }), store.update({ language: "zh-CN" })]);
  assert.deepEqual(await new UiPreferencesStore(file).get(), { appearance: "dark", language: "zh-CN" });
});

test("legacy browser values seed a missing file while an existing file remains authoritative", async t => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.get({ appearance: "light", language: "zh-CN" }), { appearance: "light", language: "zh-CN" });
  assert.deepEqual(await new UiPreferencesStore(file).get({ appearance: "dark", language: "en" }), { appearance: "light", language: "zh-CN" });
});

test("invalid patches preserve the file and later updates retain unrelated configuration fields", async t => {
  const { file, store } = await fixture(t);
  await store.get();
  const previous = await readFile(file, "utf8");
  await assert.rejects(store.update({ appearance: "invalid" } as never), /Invalid interface preference/);
  assert.equal(await readFile(file, "utf8"), previous);
  await writeFile(file, JSON.stringify({ version: 1, appearance: "system", language: "en", futureSetting: true }));
  await store.update({ language: "zh-CN" });
  assert.equal(JSON.parse(await readFile(file, "utf8")).futureSetting, true);
});

test("read and write failures reject without replacing the last valid document", async t => {
  const { directory, file, store } = await fixture(t);
  await store.get();
  await writeFile(file, "broken json");
  await assert.rejects(store.get(), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "broken json");
  await writeFile(file, JSON.stringify({ version: 2, appearance: "dark", language: "zh-CN" }));
  await assert.rejects(store.update({ appearance: "light" }), /Unsupported interface preferences/);
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "keep");
  await assert.rejects(new UiPreferencesStore(join(blocked, "ui-preferences.json")).get());
  assert.equal(await readFile(blocked, "utf8"), "keep");
  assert.deepEqual(await readdir(join(directory, "profile")), ["ui-preferences.json"]);
});
