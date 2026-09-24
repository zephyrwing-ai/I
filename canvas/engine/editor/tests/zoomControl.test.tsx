import React from "react";
import { fireEvent, render, screen } from "./test-utils";
import { Excalidraw } from "../index";

const { h } = window;

describe("zoom control", () => {
  it("commits percentages, cancels drafts, and clamps to the supported range", async () => {
    await render(<Excalidraw />);

    const input = screen.getByRole("textbox", {
      name: "Zoom",
    }) as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "24" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.zoom.value).toBe(0.24);
    expect(input.value).toBe("24%");

    fireEvent.focus(input);
    expect(input.value).toBe("24%");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    fireEvent.change(input, { target: { value: "23%" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.zoom.value).toBe(0.23);
    expect(input.value).toBe("23%");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.state.zoom.value).toBe(0.23);
    expect(input.value).toBe("23%");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.blur(input);
    expect(h.state.zoom.value).toBe(30);
    expect(input.value).toBe("3000%");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.zoom.value).toBe(0.1);
    expect(input.value).toBe("10%");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "23abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.state.zoom.value).toBe(0.1);
    expect(input.value).toBe("10%");
  });
});
