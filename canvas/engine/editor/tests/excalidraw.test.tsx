import React from "react";
import { fireEvent, GlobalTestState, render } from "./test-utils";
import { Excalidraw, Footer } from "../index";
import { queryByText } from "@testing-library/react";

const { h } = window;

describe("<Excalidraw/>", () => {
  describe("Test zenModeEnabled prop", () => {
    it('should show exit zen mode button and context-menu option when zenModeEnabled is "undefined"', async () => {
      const { container } = await render(<Excalidraw />);
      expect(
        container.getElementsByClassName("disable-zen-mode--visible").length,
      ).toBe(0);
      expect(h.state.zenModeEnabled).toBe(false);

      fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
        button: 2,
        clientX: 1,
        clientY: 1,
      });
      const contextMenu = document.querySelector(".context-menu");
      fireEvent.click(queryByText(contextMenu as HTMLElement, "Zen mode")!);
      expect(h.state.zenModeEnabled).toBe(true);
      expect(
        container.getElementsByClassName("disable-zen-mode--visible").length,
      ).toBe(1);
    });

    it("should not show the exit button or context-menu option when zen mode is fixed on", async () => {
      const { container } = await render(<Excalidraw zenModeEnabled={true} />);
      expect(
        container.getElementsByClassName("disable-zen-mode--visible").length,
      ).toBe(0);
      expect(h.state.zenModeEnabled).toBe(true);

      fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
        button: 2,
        clientX: 1,
        clientY: 1,
      });
      const contextMenu = document.querySelector(".context-menu");
      expect(queryByText(contextMenu as HTMLElement, "Zen mode")).toBe(null);
      expect(h.state.zenModeEnabled).toBe(true);
      expect(
        container.getElementsByClassName("disable-zen-mode--visible").length,
      ).toBe(0);
    });
  });

  it("renders a custom footer only when Footer is passed as children", async () => {
    let { container } = await render(
      <Excalidraw>
        <div>This is a custom footer</div>
      </Excalidraw>,
    );
    expect(container.querySelector(".footer-center")).toBe(null);

    ({ container } = await render(
      <Excalidraw>
        <Footer>
          <div>This is a custom footer</div>
        </Footer>
      </Excalidraw>,
    ));
    expect(container.querySelector(".footer-center")).toMatchInlineSnapshot(
      `
      <div
        class="footer-center zen-mode-transition"
      >
        <div>
          This is a custom footer
        </div>
      </div>
    `,
    );
  });

  describe("Test gridModeEnabled prop", () => {
    it('shows the grid context-menu action when gridModeEnabled is "undefined"', async () => {
      await render(<Excalidraw />);
      expect(h.state.gridModeEnabled).toBe(false);

      fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
        button: 2,
        clientX: 1,
        clientY: 1,
      });
      const contextMenu = document.querySelector(".context-menu");
      fireEvent.click(queryByText(contextMenu as HTMLElement, "Toggle grid")!);
      expect(h.state.gridModeEnabled).toBe(true);
    });

    it('omits the grid context-menu action when gridModeEnabled is explicitly "false"', async () => {
      await render(<Excalidraw gridModeEnabled={false} />);
      expect(h.state.gridModeEnabled).toBe(false);

      fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
        button: 2,
        clientX: 1,
        clientY: 1,
      });
      const contextMenu = document.querySelector(".context-menu");
      expect(queryByText(contextMenu as HTMLElement, "Show grid")).toBe(null);
      expect(h.state.gridModeEnabled).toBe(false);
    });
  });

  describe("Test autoFocus prop", () => {
    it("does not focus when autoFocus is false", async () => {
      const { container } = await render(<Excalidraw />);
      expect(container.querySelector(".excalidraw") === document.activeElement).toBe(false);
    });

    it("focuses when autoFocus is true", async () => {
      const { container } = await render(<Excalidraw autoFocus={true} />);
      expect(container.querySelector(".excalidraw") === document.activeElement).toBe(true);
    });
  });
});
