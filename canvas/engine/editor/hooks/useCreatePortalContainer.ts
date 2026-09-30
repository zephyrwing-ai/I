import { useState, useLayoutEffect } from "react";
import { useDevice, useCanvasEditorContainer } from "../components/App";
import { THEME } from "../constants";
import { useUIAppState } from "../context/ui-appState";

export const useCreatePortalContainer = (opts?: {
  className?: string;
  parentSelector?: string;
}) => {
  const [div, setDiv] = useState<HTMLDivElement | null>(null);

  const device = useDevice();
  const { theme } = useUIAppState();

  const { container: canvasContainer } = useCanvasEditorContainer();

  useLayoutEffect(() => {
    if (div) {
      div.className = "";
      div.classList.add("agent-canvas", ...(opts?.className?.split(/\s+/) || []));
      div.classList.toggle("agent-canvas--mobile", device.editor.isMobile);
      div.classList.toggle("theme--dark", theme === THEME.DARK);
    }
  }, [div, theme, device.editor.isMobile, opts?.className]);

  useLayoutEffect(() => {
    const container = opts?.parentSelector
      ? canvasContainer?.querySelector(opts.parentSelector)
      : document.body;

    if (!container) {
      return;
    }

    const div = document.createElement("div");

    container.appendChild(div);

    setDiv(div);

    return () => {
      container.removeChild(div);
    };
  }, [canvasContainer, opts?.parentSelector]);

  return div;
};
