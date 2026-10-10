import type { CanvasEditOperation } from "../commands/types.js";
import { applyThroughParent } from "./client.js";
import { MAX_CLI_BYTES, isRecord, type CanvasCliReply } from "./protocol.js";

async function readOperations(): Promise<CanvasEditOperation[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CLI_BYTES) throw new Error("Canvas CLI input exceeds the command size limit.");
    chunks.push(bytes);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Canvas CLI input must be valid JSON containing operations.");
  }
  if (!isRecord(input) || !Array.isArray(input.operations)) {
    throw new Error("Canvas CLI input must contain an operations array.");
  }
  return input.operations as CanvasEditOperation[];
}

async function main(): Promise<void> {
  if (process.argv[2] === "--help") {
    process.stdout.write("Canvas CLI: apply\nReads { operations: [...] } from stdin; canvas_edit supplies the application IPC connection.\n");
    if (process.connected) process.disconnect();
    return;
  }
  let reply: CanvasCliReply;
  try {
    if (process.argv[2] !== "apply" || process.argv.length !== 3) throw new Error("Canvas CLI expects the apply command.");
    const result = await applyThroughParent(await readOperations());
    reply = { kind: "canvas:result", result };
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    reply = {
      kind: "canvas:error",
      code: isRecord(error) && typeof error.code === "string" ? error.code : "canvas_unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  }
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(reply)}\n`, () => resolve()));
  if (process.connected) process.disconnect();
}

void main();
