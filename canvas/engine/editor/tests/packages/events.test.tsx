import React from "react";
import { vi } from "vitest";
import { CanvasEditor, CaptureUpdateAction } from "../../index";
import type { CanvasEditorImperativeAPI } from "../../types";
import { resolvablePromise } from "../../utils";
import { render } from "../test-utils";
import { Pointer } from "../helpers/ui";
import { API } from "../helpers/api";

describe("event callbacks", () => {
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

  it("should trigger onChange on render", async () => {
    const onChange = vi.fn();

    const origBackgroundColor = h.state.viewBackgroundColor;
    canvasAPI.onChange(onChange);
    API.updateScene({
      appState: { viewBackgroundColor: "red" },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    expect(onChange).toHaveBeenCalledWith(
      // elements
      [],
      // appState
      expect.objectContaining({
        viewBackgroundColor: "red",
      }),
      // files
      {},
    );
    expect(onChange.mock?.lastCall?.[1].viewBackgroundColor).not.toBe(
      origBackgroundColor,
    );
  });

  it("should trigger onPointerDown/onPointerUp on canvas pointerDown/pointerUp", async () => {
    const onPointerDown = vi.fn();
    const onPointerUp = vi.fn();

    canvasAPI.onPointerDown(onPointerDown);
    canvasAPI.onPointerUp(onPointerUp);

    mouse.downAt(100);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).not.toHaveBeenCalled();
    mouse.up();
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);
  });
});
