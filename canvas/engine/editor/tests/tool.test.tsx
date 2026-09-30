import React from "react";
import { CanvasEditor } from "../index";
import type { CanvasEditorImperativeAPI } from "../types";
import { resolvablePromise } from "../utils";
import { act, render } from "./test-utils";
import { Pointer } from "./helpers/ui";

describe("setActiveTool()", () => {
  const h = window.h;

  let canvasAPI: CanvasEditorImperativeAPI;

  const mouse = new Pointer("mouse");

  beforeEach(async () => {
    const canvasAPIPromise = resolvablePromise<CanvasEditorImperativeAPI>();
    await render(
      <CanvasEditor
        canvasAPI={(api) => canvasAPIPromise.resolve(api as any)}
      />,
    );
    canvasAPI = await canvasAPIPromise;
  });

  it("should expose setActiveTool on package API", () => {
    expect(canvasAPI.setActiveTool).toBeDefined();
    expect(canvasAPI.setActiveTool).toBe(h.app.setActiveTool);
  });

  it("should set the active tool type", async () => {
    expect(h.state.activeTool.type).toBe("selection");
    act(() => {
      canvasAPI.setActiveTool({ type: "rectangle" });
    });
    expect(h.state.activeTool.type).toBe("rectangle");

    mouse.down(10, 10);
    mouse.up(20, 20);

    expect(h.state.activeTool.type).toBe("selection");
  });

  it("should support tool locking", async () => {
    expect(h.state.activeTool.type).toBe("selection");
    act(() => {
      canvasAPI.setActiveTool({ type: "rectangle", locked: true });
    });
    expect(h.state.activeTool.type).toBe("rectangle");

    mouse.down(10, 10);
    mouse.up(20, 20);

    expect(h.state.activeTool.type).toBe("rectangle");
  });

  it("should set custom tool", async () => {
    expect(h.state.activeTool.type).toBe("selection");
    act(() => {
      canvasAPI.setActiveTool({ type: "custom", customType: "comment" });
    });
    expect(h.state.activeTool.type).toBe("custom");
    expect(h.state.activeTool.customType).toBe("comment");
  });
});
