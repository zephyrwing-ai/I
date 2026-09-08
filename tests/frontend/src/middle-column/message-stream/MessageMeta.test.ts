import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement, ReactNode } from "react";
import { MessageMeta } from "../../../../../frontend/src/middle-column/message-stream/MessageMeta.js";

function findButton(node: ReactNode): ReactElement<{ onClick: () => void }> | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.type === "button" && element.props.onClick) {
    return element as ReactElement<{ onClick: () => void }>;
  }
  const children = element.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const button = findButton(child);
      if (button) return button;
    }
    return undefined;
  }
  return findButton(children);
}

test("message copy writes the exact text supplied by its caller", async () => {
  const copied: string[] = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  });

  try {
    const source = "**原始内容**，保留标记";
    const button = findButton(MessageMeta({ time: 0, text: source }));
    assert.ok(button, "copy button should be rendered");
    button.props.onClick();
    await Promise.resolve();
    assert.deepEqual(copied, [source]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
