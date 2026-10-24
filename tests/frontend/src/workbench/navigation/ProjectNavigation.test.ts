import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("../../../css-module-loader.mjs", import.meta.url);
const { ProjectNavigation } = await import("../../../../../frontend/src/workbench/navigation/ProjectNavigation.js");

test("left navigation contains I, Project, and bottom Settings entries", () => {
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    selected: "ordinary", projectsOpen: false, settingsOpen: false, settingsButtonRef: { current: null }, onOrdinary: () => undefined, onProjects: () => undefined, onSettings: () => undefined,
  }));
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.match(html, /aria-label="I" aria-current="page"/);
  assert.match(html, /aria-label="Project" aria-expanded="false" aria-controls="projects-panel"/);
  assert.match(html, /class="project-navigation-item project-navigation-settings" aria-label="Settings" aria-expanded="false"/);
  assert.doesNotMatch(html, /<span>Settings<\/span>/);
  assert.doesNotMatch(html, /Add project/);
  assert.match(html, /<svg[^>]+class="project-navigation-brand"/);
  assert.doesNotMatch(html, /<rect|<img/);
});
