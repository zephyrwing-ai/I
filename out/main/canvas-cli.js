import { i as isCliReply, a as isRecord, M as MAX_CLI_BYTES } from "./protocol-BcvILXCM.js";
function applyThroughParent(operations) {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error("Canvas CLI requires the application IPC connection supplied by canvas_edit."));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onDisconnect = () => fail(new Error("The Canvas application connection closed before confirmation."));
    const onMessage = (message) => {
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
    const request = { kind: "canvas:apply", operations };
    try {
      process.send(request, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
async function readOperations() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CLI_BYTES) throw new Error("Canvas CLI input exceeds the command size limit.");
    chunks.push(bytes);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Canvas CLI input must be valid JSON containing operations.");
  }
  if (!isRecord(input) || !Array.isArray(input.operations)) {
    throw new Error("Canvas CLI input must contain an operations array.");
  }
  return input.operations;
}
async function main() {
  if (process.argv[2] === "--help") {
    process.stdout.write("Canvas CLI: apply\nReads { operations: [...] } from stdin; canvas_edit supplies the application IPC connection.\n");
    if (process.connected) process.disconnect();
    return;
  }
  let reply;
  try {
    if (process.argv[2] !== "apply" || process.argv.length !== 3) throw new Error("Canvas CLI expects the apply command.");
    const result = await applyThroughParent(await readOperations());
    reply = { kind: "canvas:result", result };
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    reply = {
      kind: "canvas:error",
      code: isRecord(error) && typeof error.code === "string" ? error.code : "canvas_unavailable",
      message: error instanceof Error ? error.message : String(error)
    };
    process.exitCode = 1;
  }
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(reply)}
`, () => resolve()));
  if (process.connected) process.disconnect();
}
void main();
