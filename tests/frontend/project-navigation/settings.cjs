const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { nativeTheme } = require("electron");

async function verifySettingsNavigation(window) {
  const evaluate = (script) => window.webContents.executeJavaScript(script);
  const painted = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const waitFor = async (condition) => evaluate(`(async () => {
    const deadline = performance.now() + 5000;
    while (!(${condition})) {
      if (performance.now() > deadline) throw new Error('Settings navigation timed out: ' + ${JSON.stringify(condition)});
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  })()`);
  const moveTo = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Pointer target is missing: ' + ${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Click target is covered: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    return point;
  };
  const click = async (selector) => {
    const point = await moveTo(selector);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const press = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await painted();
  };

  await waitFor("document.querySelector('.task-input')?.disabled === false");
  await waitFor("document.getElementById('composer-model')?.disabled === false");
  const initialModelSize = window.getContentSize();
  for (const [width, align, menuWidth] of [[initialModelSize[0], "center", 250], [640, "end", 220]]) {
    window.setContentSize(width, initialModelSize[1]);
    await waitFor(`innerWidth === ${width}`);
    await painted();
    await evaluate("Promise.all(document.getElementById('composer-model').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#composer-model > svg')).transform"), "matrix(1, 0, 0, 1, 0, 0)");
    await click("#composer-model");
    await waitFor(`document.getElementById('composer-model-listbox')?.dataset.align === '${align}'`);
    await evaluate("Promise.all([...document.getElementById('composer-model').getAnimations({ subtree: true }), ...document.getElementById('composer-model-listbox').getAnimations()].map(animation => animation.finished.catch(() => undefined)))");
    const modelMenu = await evaluate(`(() => {
      const trigger = document.getElementById('composer-model');
      const menu = document.getElementById('composer-model-listbox');
      const buttonRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      return { shared: trigger.classList.contains('ui-select-trigger') && menu.classList.contains('ui-select-content'),
        side: menu.dataset.side, gap: buttonRect.top - menuRect.bottom, width: menuRect.width,
        alignmentOffset: ${align === "center" ? "(buttonRect.left + buttonRect.right - menuRect.left - menuRect.right) / 2" : "buttonRect.right - menuRect.right"},
        arrow: getComputedStyle(trigger.querySelector('svg')).transform };
    })()`);
    assert.ok(modelMenu.shared);
    assert.equal(modelMenu.side, "top");
    assert.ok(Math.abs(modelMenu.gap - 8) <= 1, JSON.stringify(modelMenu));
    assert.ok(Math.abs(modelMenu.alignmentOffset) <= 1, JSON.stringify(modelMenu));
    assert.equal(modelMenu.width, menuWidth);
    assert.equal(modelMenu.arrow, "matrix(0, 1, -1, 0, 0, 0)");
    await click("#composer-model-option-0");
    await waitFor("!document.getElementById('composer-model-listbox') && document.activeElement.id === 'composer-model'");
  }
  window.setContentSize(...initialModelSize);
  await waitFor(`innerWidth === ${initialModelSize[0]}`);
  await painted();
  const before = await evaluate(`(() => {
    const trigger = document.querySelector('.project-navigation-settings');
    const rect = trigger.getBoundingClientRect();
    const frame = document.querySelector('.workbench-frame');
    const input = document.querySelector('.task-input');
    window.settingsRegressionState = { frame, input, stream: document.querySelector('.stream-scroll') };
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Retain this Settings draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { left: rect.left, right: frame.getBoundingClientRect().left - rect.right, text: trigger.textContent.trim() };
  })()`);
  assert.equal(before.text, "");
  assert.equal(before.left, before.right, JSON.stringify(before));
  assert.equal(before.left, 8);

  await click(".project-navigation-settings");
  await waitFor("document.querySelector('.settings-page') && document.activeElement === document.querySelector('.settings-page-back')");
  const page = await evaluate(`(() => {
    const root = document.querySelector('.settings-page').getBoundingClientRect();
    const back = document.querySelector('.settings-page-back');
    const drag = document.querySelector('.settings-page-sidebar .settings-page-titlebar').getBoundingClientRect();
    return {
      left: root.left, top: root.top, width: root.width, height: root.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      shellDisplay: getComputedStyle(document.querySelector('.workbench-page')).display,
      backRegion: getComputedStyle(back).webkitAppRegion,
      backTop: back.getBoundingClientRect().top, dragBottom: drag.bottom,
      bodyFont: getComputedStyle(document.body).fontFamily, backFont: getComputedStyle(back).fontFamily,
      backRadius: getComputedStyle(back).borderRadius,
      frameRetained: document.querySelector('.workbench-frame') === window.settingsRegressionState.frame,
    };
  })()`);
  assert.equal(page.left, 0);
  assert.equal(page.top, 0);
  assert.equal(page.width, page.viewportWidth);
  assert.equal(page.height, page.viewportHeight);
  assert.equal(page.shellDisplay, "none");
  assert.equal(page.backRegion, "no-drag");
  assert.ok(page.backTop >= page.dragBottom);
  assert.equal(page.bodyFont, page.backFont);
  assert.equal(page.backRadius, "12px");
  assert.ok(page.frameRetained);

  const verifyGeneralLayout = async () => {
    const layout = await evaluate(`(() => {
      const frame = document.querySelector('.settings-page-main');
      const frameRect = frame.getBoundingClientRect();
      const frameStyle = getComputedStyle(frame);
      const title = document.querySelector('#settings-general-title').getBoundingClientRect();
      const list = document.querySelector('.settings-general-list');
      const listRect = list.getBoundingClientRect();
      const listStyle = getComputedStyle(list);
      const drag = frame.querySelector('.settings-page-titlebar');
      const dragRect = drag.getBoundingClientRect();
      const content = document.querySelector('.settings-page-content');
      return {
        left: title.left - frameRect.left - parseFloat(frameStyle.borderLeftWidth),
        top: title.top - frameRect.top - parseFloat(frameStyle.borderTopWidth),
        right: frameRect.right - parseFloat(frameStyle.borderRightWidth) - listRect.right,
        titleLeft: title.left, listLeft: listRect.left, listWidth: listRect.width,
        listInnerWidth: list.clientWidth,
        rowWidths: [...list.children].map(row => row.getBoundingClientRect().width),
        rowHeights: [...list.children].map(row => row.getBoundingClientRect().height),
        listBorders: ['Top', 'Right', 'Bottom', 'Left'].map(side => listStyle['border' + side + 'Width']),
        rowDividers: [...list.children].map(row => getComputedStyle(row).borderTopWidth),
        dragHeight: dragRect.height, dragBottom: dragRect.bottom, titleTop: title.top,
        dragRegion: getComputedStyle(drag).webkitAppRegion,
        contentRegion: getComputedStyle(content).webkitAppRegion,
        contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
      };
    })()`);
    assert.equal(layout.left, 40, JSON.stringify(layout));
    assert.equal(layout.top, 32, JSON.stringify(layout));
    assert.equal(layout.right, layout.left, JSON.stringify(layout));
    assert.equal(layout.titleLeft, layout.listLeft);
    assert.ok(layout.rowWidths.every(width => width === layout.listInnerWidth));
    assert.ok(layout.rowHeights.every(height => height === 48), JSON.stringify(layout));
    assert.deepEqual(layout.listBorders, ["0px", "0px", "0px", "0px"]);
    assert.deepEqual(layout.rowDividers, ["0px", "1px"]);
    assert.equal(layout.dragHeight, layout.top);
    assert.ok(layout.dragBottom <= layout.titleTop);
    assert.equal(layout.dragRegion, "drag");
    assert.equal(layout.contentRegion, "no-drag");
    assert.ok(layout.contentScrollWidth <= layout.contentWidth);
    return layout;
  };
  const wideLayout = await verifyGeneralLayout();
  assert.ok(wideLayout.listWidth > 760, JSON.stringify(wideLayout));
  const initialContentSize = window.getContentSize();
  window.setContentSize(840, initialContentSize[1]);
  await waitFor("innerWidth === 840");
  await painted();
  const narrowLayout = await verifyGeneralLayout();
  assert.ok(narrowLayout.listWidth < wideLayout.listWidth);
  window.setContentSize(...initialContentSize);
  await waitFor(`innerWidth === ${initialContentSize[0]}`);
  await painted();

  for (const section of ["providers", "usage", "tts", "general", "providers"]) {
    await click(`#settings-nav-${section}`);
    await waitFor(`document.querySelector('#settings-content-${section} h1') && document.querySelector('#settings-nav-${section}')?.getAttribute('aria-current') === 'page'`);
  }
  assert.ok(await evaluate("!!document.querySelector('#settings-content-providers .provider-list')"));
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))");
  assert.equal(await evaluate("!!document.querySelector('.search-layer')"), false);

  await click("#settings-nav-general");
  await waitFor("!!document.querySelector('#settings-general-title')");
  if (process.env.PROJECT_NAVIGATION_SETTINGS_SCREENSHOT) {
    await painted();
    await writeFile(process.env.PROJECT_NAVIGATION_SETTINGS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  }
  nativeTheme.themeSource = "dark";
  await waitFor("matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme === 'dark'");
  if (process.env.PROJECT_NAVIGATION_SETTINGS_DARK_SCREENSHOT) {
    await painted();
    await writeFile(process.env.PROJECT_NAVIGATION_SETTINGS_DARK_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  }

  let selectScreenshotCaptured = false;
  const openSelect = async (id) => {
    const bounds = window.getBounds();
    await click(`#${id}-label`);
    await painted();
    assert.equal(await evaluate(`document.getElementById('${id}').getAttribute('aria-expanded')`), "false");
    assert.equal(await evaluate(`!!document.getElementById('${id}-listbox')`), false);
    await moveTo("#settings-general-title");
    await painted();
    const trigger = await evaluate(`(() => {
      const trigger = document.getElementById(${JSON.stringify(id)});
      const style = getComputedStyle(trigger);
      const hover = document.createElement('span').style;
      hover.backgroundColor = style.getPropertyValue('--hover').trim();
      return {
        tag: trigger.tagName, role: trigger.getAttribute('role'),
        hasPopup: trigger.getAttribute('aria-haspopup'), expanded: trigger.getAttribute('aria-expanded'),
        controls: trigger.getAttribute('aria-controls'), labelledBy: trigger.getAttribute('aria-labelledby'),
        localLabel: !!trigger.closest('.settings-general-row').querySelector('dt #${id}-label'),
        value: document.getElementById('${id}-value').textContent,
        shared: trigger.classList.contains('ui-select-trigger'),
        height: trigger.getBoundingClientRect().height, minHeight: style.minHeight,
        radius: style.borderRadius, background: style.backgroundColor, hoverBackground: hover.backgroundColor,
        borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => style['border' + side + 'Width']),
        region: style.webkitAppRegion, listboxes: document.querySelectorAll('.ui-select-content[role="listbox"]').length,
      };
    })()`);
    assert.equal(trigger.tag, "BUTTON");
    assert.equal(trigger.role, "combobox");
    assert.equal(trigger.hasPopup, "listbox");
    assert.equal(trigger.expanded, "false");
    assert.equal(trigger.controls, `${id}-listbox`);
    assert.equal(trigger.labelledBy, `${id}-label ${id}-value`);
    assert.ok(trigger.localLabel && trigger.shared);
    assert.equal(trigger.listboxes, 0);
    assert.ok(trigger.height >= 32);
    assert.equal(trigger.minHeight, "32px");
    assert.equal(trigger.radius, "16px");
    assert.equal(trigger.background, "rgba(0, 0, 0, 0)");
    assert.deepEqual(trigger.borders, ["0px", "0px", "0px", "0px"]);
    assert.equal(trigger.region, "no-drag");
    await moveTo(`#${id}`);
    await painted();
    assert.equal(await evaluate(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`), trigger.hoverBackground);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).borderRadius`), "16px");
    await click(`#${id}`);
    await waitFor(`document.getElementById('${id}').getAttribute('aria-expanded') === 'true' && !!document.getElementById('${id}-listbox')`);
    await painted();
    const menu = await evaluate(`(() => {
      const trigger = document.getElementById('${id}');
      const menu = document.getElementById('${id}-listbox');
      const triggerRect = trigger.getBoundingClientRect();
      const rect = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      return {
        tag: menu.tagName, role: menu.getAttribute('role'), labelledBy: menu.getAttribute('aria-labelledby'),
        shared: menu.classList.contains('ui-select-content'),
        portal: document.body.contains(menu) && !document.getElementById('root').contains(menu),
        side: menu.dataset.side, align: menu.dataset.align,
        gap: rect.top - triggerRect.bottom, rightOffset: rect.right - triggerRect.right,
        inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => style['border' + side + 'Width']),
        region: style.webkitAppRegion, focused: document.activeElement === trigger,
        active: trigger.getAttribute('aria-activedescendant'),
        options: [...menu.querySelectorAll('[role="option"]')].map(option => {
          const check = option.querySelector('svg');
          return {
            tag: option.tagName, id: option.id, value: option.dataset.value,
            label: option.querySelector('span').textContent, selected: option.getAttribute('aria-selected'),
            shared: option.classList.contains('ui-select-option'),
            checked: !!check && check.getBoundingClientRect().width > 0 && getComputedStyle(check).visibility === 'visible' && getComputedStyle(check).opacity !== '0',
          };
        }),
      };
    })()`);
    assert.equal(menu.tag, "DIV");
    assert.equal(menu.role, "listbox");
    assert.equal(menu.labelledBy, `${id}-label`);
    assert.ok(menu.shared && menu.portal && menu.inViewport && menu.focused, JSON.stringify(menu));
    assert.equal(menu.side, "bottom");
    assert.equal(menu.align, "end");
    assert.ok(Math.abs(menu.gap - 8) <= 1, JSON.stringify(menu));
    assert.ok(Math.abs(menu.rightOffset) <= 1, JSON.stringify(menu));
    assert.deepEqual(menu.borders, ["0px", "0px", "0px", "0px"]);
    assert.equal(menu.region, "no-drag");
    assert.deepEqual(menu.options.map(option => option.value), id === "settings-appearance" ? ["system", "light", "dark"] : ["en", "zh-CN"]);
    assert.equal(menu.options.filter(option => option.selected === "true").length, 1);
    for (const [index, option] of menu.options.entries()) {
      assert.equal(option.tag, "DIV");
      assert.equal(option.id, `${id}-option-${index}`);
      assert.ok(option.shared);
      assert.equal(option.selected, option.label === trigger.value ? "true" : "false");
      assert.equal(option.checked, option.selected === "true");
    }
    assert.equal(menu.active, menu.options.find(option => option.selected === "true").id);
    assert.deepEqual(window.getBounds(), bounds);
    if (id === "settings-appearance" && process.env.PROJECT_NAVIGATION_SELECT_SCREENSHOT && !selectScreenshotCaptured) {
      await evaluate(`Promise.all(document.getElementById('${id}').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))`);
      await writeFile(process.env.PROJECT_NAVIGATION_SELECT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
      selectScreenshotCaptured = true;
    }
    return menu.options;
  };
  const waitForClosed = async (id, focusedId = id) => {
    await waitFor(`document.getElementById('${id}').getAttribute('aria-expanded') === 'false' && !document.getElementById('${id}-listbox') && document.activeElement === document.getElementById('${focusedId}')`);
    assert.equal(await evaluate(`document.getElementById('${id}').hasAttribute('aria-activedescendant')`), false);
  };
  const select = async (id, value) => {
    const bounds = window.getBounds();
    const options = await openSelect(id);
    const option = options.find(option => option.value === value);
    assert.ok(option, `${id} has option ${value}`);
    await click(`#${option.id}`);
    await waitForClosed(id);
    await painted();
    assert.equal(await evaluate(`document.getElementById('${id}-value').textContent`), option.label);
    assert.deepEqual(window.getBounds(), bounds);
  };

  const preferencesBeforeDismissal = await evaluate("localStorage.getItem('workbench.uiPreferences')");
  const dropdownBounds = window.getBounds();
  await openSelect("settings-appearance");
  await press("Escape");
  await waitForClosed("settings-appearance");
  await openSelect("settings-appearance");
  await click("#settings-nav-general");
  await waitForClosed("settings-appearance", "settings-nav-general");
  await openSelect("settings-appearance");
  await press("Tab");
  await waitForClosed("settings-appearance", "settings-language");
  await openSelect("settings-language");
  await press("Tab", ["shift"]);
  await waitForClosed("settings-language", "settings-appearance");
  assert.equal(await evaluate("localStorage.getItem('workbench.uiPreferences')"), preferencesBeforeDismissal);

  // Keyboard navigation changes the active option; Enter commits it while focus stays on the trigger.
  await press("Down");
  await waitFor("document.getElementById('settings-appearance').getAttribute('aria-expanded') === 'true' && document.getElementById('settings-appearance-listbox')");
  for (const [key, index] of [["End", 2], ["Up", 1], ["Home", 0], ["Up", 2], ["Down", 0]]) {
    await press(key);
    assert.equal(await evaluate("document.getElementById('settings-appearance').getAttribute('aria-activedescendant')"), `settings-appearance-option-${index}`);
    assert.equal(await evaluate("document.activeElement.id"), "settings-appearance");
    assert.equal(await evaluate("document.querySelector('#settings-appearance-listbox [aria-selected=\"true\"]').dataset.value"), "system");
  }
  await press("Down");
  await press("Enter");
  await waitForClosed("settings-appearance");
  await waitFor("document.documentElement.dataset.theme === 'light' && JSON.parse(localStorage.getItem('workbench.uiPreferences')).appearance === 'light'");
  await press("Space");
  await waitFor("document.getElementById('settings-appearance').getAttribute('aria-expanded') === 'true' && document.getElementById('settings-appearance-listbox')");
  await press("Home");
  await press("Space");
  await waitForClosed("settings-appearance");
  await waitFor("document.documentElement.dataset.theme === 'dark' && JSON.parse(localStorage.getItem('workbench.uiPreferences')).appearance === 'system'");
  window.setContentSize(840, initialContentSize[1]);
  await waitFor("innerWidth === 840");
  await painted();
  await openSelect("settings-language");
  await press("Escape");
  await waitForClosed("settings-language");
  window.setContentSize(...initialContentSize);
  await waitFor(`innerWidth === ${initialContentSize[0]}`);
  await painted();
  assert.deepEqual(window.getBounds(), dropdownBounds);

  await select("settings-appearance", "light");
  await waitFor("document.documentElement.dataset.theme === 'light'");
  assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()"), "#ffffff");
  await select("settings-language", "zh-CN");
  await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('#settings-general-title').textContent === '通用'");
  assert.equal(await evaluate("document.querySelector('#project-navigation-projects span').textContent"), "项目");
  assert.equal(await evaluate("document.querySelector('.task-input').placeholder"), "有什么想做的？");
  await click("#settings-nav-providers");
  await waitFor("document.querySelector('.add-provider-button')?.textContent === '添加提供商'");
  await click("#settings-nav-general");
  await waitFor("!!document.querySelector('#settings-appearance')");
  nativeTheme.themeSource = "light";
  await waitFor("!matchMedia('(prefers-color-scheme: dark)').matches");
  await select("settings-appearance", "dark");
  await waitFor("document.documentElement.dataset.theme === 'dark'");
  await waitFor("JSON.parse(localStorage.getItem('workbench.uiPreferences')).appearance === 'dark' && JSON.parse(localStorage.getItem('workbench.uiPreferences')).language === 'zh-CN'");

  const bounds = window.getBounds();
  await click(".settings-page-back");
  await waitFor("!document.querySelector('.settings-page') && document.activeElement === document.querySelector('.project-navigation-settings')");
  assert.deepEqual(window.getBounds(), bounds);
  const restored = await evaluate(`(() => {
    const saved = window.settingsRegressionState;
    const input = document.querySelector('.task-input');
    const result = {
      frameRetained: document.querySelector('.workbench-frame') === saved.frame,
      inputRetained: input === saved.input,
      streamRetained: document.querySelector('.stream-scroll') === saved.stream,
      draft: input.value,
    };
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    delete window.settingsRegressionState;
    return result;
  })()`);
  assert.ok(restored.frameRetained && restored.inputRetained && restored.streamRetained);
  assert.equal(restored.draft, "Retain this Settings draft");
  await new Promise(resolve => {
    window.webContents.once("did-finish-load", resolve);
    window.reload();
  });
  await waitFor("document.querySelector('.task-input')?.disabled === false && document.documentElement.dataset.theme === 'dark' && document.documentElement.lang === 'zh-CN'");
  await click(".project-navigation-settings");
  await waitFor("document.querySelector('#settings-appearance')?.value === 'dark' && document.querySelector('#settings-language')?.value === 'zh-CN'");
  await select("settings-language", "en");
  await select("settings-appearance", "system");
  await waitFor("document.documentElement.dataset.theme === 'light' && document.documentElement.lang === 'en'");
  await click(".settings-page-back");
  await waitFor("!document.querySelector('.settings-page')");
  nativeTheme.themeSource = "light";
  await waitFor("!matchMedia('(prefers-color-scheme: dark)').matches");
  return { gap: before.left, backRegion: page.backRegion, draftRetained: true };
}

module.exports = { verifySettingsNavigation };
