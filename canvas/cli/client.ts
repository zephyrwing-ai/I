import type { CanvasEditOperation, CanvasEditResult } from "../commands/types.js";
import { isCliReply, type CanvasCliRequest } from "./protocol.js";

/** The parent owns the project/window authority for this one tool invocation. */
export function applyThroughParent(operations: CanvasEditOperation[]): Promise<CanvasEditResult> {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error("Canvas CLI requires the application IPC connection supplied by canvas_edit."));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const onDisconnect = () => fail(new Error("The Canvas application connection closed before confirmation."));
    const onMessage = (message: unknown) => {
      if (!isCliReply(message)) {
        fail(new Error("The Canvas application returned an invalid reply."));
        return;
      }
      cleanup();
      if (message.kind === "canvas:error") {
        const error = Object.assign(new Error(message.message), { code: message.code });
        reject(error);
      } else {
        resolve(message.result);
      }
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    const request: CanvasCliRequest = { kind: "canvas:apply", operations };
    try {
      process.send!(request, (error: Error | null) => { if (error) fail(error); });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
