import React from "react";
import * as StaticScene from "../renderer/staticScene";
import { reseed } from "../random";
import { render, queryByTestId, unmountComponent } from "../tests/test-utils";

import { CanvasEditor } from "../index";
import { vi } from "vitest";

const renderStaticScene = vi.spyOn(StaticScene, "renderStaticScene");

describe("Test <App/>", () => {
  beforeEach(async () => {
    unmountComponent();
    localStorage.clear();
    renderStaticScene.mockClear();
    reseed(7);
  });

  it("should show error modal when using brave and measureText API is not working", async () => {
    (global.navigator as any).brave = {
      isBrave: {
        name: "isBrave",
      },
    };

    const originalContext = global.HTMLCanvasElement.prototype.getContext("2d");
    //@ts-ignore
    global.HTMLCanvasElement.prototype.getContext = (contextId) => {
      return {
        ...originalContext,
        measureText: () => ({
          width: 0,
        }),
      };
    };

    await render(<CanvasEditor />);
    expect(
      queryByTestId(
        document.querySelector(".agent-canvas-modal-container")!,
        "brave-measure-text-error",
      ),
    ).toMatchSnapshot();
  });
});
