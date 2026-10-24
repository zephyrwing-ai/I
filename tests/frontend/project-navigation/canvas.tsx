import { forwardRef, useImperativeHandle } from "react";

// Navigation exercises the Canvas lifecycle boundary; the engine has its own regression fixture.
export const canvasOperations: string[] = [];
export const CanvasSurface = forwardRef(function CanvasSurface({ projectId }: { projectId: string | null }, ref) {
  useImperativeHandle(ref, () => ({ flush: async () => { canvasOperations.push("flush"); } }));
  return <div data-canvas-scope={projectId ?? "ordinary"}>Canvas</div>;
});
export const preloadCanvasEditor = async () => undefined;
export const preloadCanvasDocument = async (projectId: string | null) => { canvasOperations.push(`preload:${projectId}`); };
export const resetPreloadedCanvasDocument = () => { canvasOperations.push("reset"); };
