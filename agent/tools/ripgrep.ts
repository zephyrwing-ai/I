import childProcess from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

export type RipgrepStop = "cancelled" | "invalid_output" | "execution_failed";

export interface RipgrepOutcome {
  code: number | null;
  stop?: RipgrepStop;
  diagnostic: string;
}

/** Collect frame fragments and assemble each complete NUL path or JSON line once. */
export function runRipgrep(options: {
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  delimiter: number;
  onFrame(frame: Buffer): void;
}): Promise<RipgrepOutcome> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, stop: "cancelled", diagnostic: "" });

  return new Promise((resolve) => {
    let child: ReturnType<typeof childProcess.spawn>;
    try {
      child = childProcess.spawn(rgPath, ["--no-config", ...options.args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stop: "execution_failed", diagnostic: diagnosticText(error) });
      return;
    }

    let frameParts: Buffer[] = [];
    let frameBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stop: RipgrepStop | undefined;
    let failure = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const halt = (reason: RipgrepStop) => {
      if (stop) return;
      stop = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref();
    };
    const abort = () => halt("cancelled");
    const failed = (error: unknown) => {
      failure = diagnosticText(error);
      halt("execution_failed");
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stop) return;
      let offset = 0;
      while (offset < chunk.length && !stop) {
        const end = chunk.indexOf(options.delimiter, offset);
        const next = end < 0 ? chunk.length : end;
        const length = next - offset;
        if (length > 0) frameParts.push(chunk.subarray(offset, next));
        frameBytes += length;
        if (end < 0) return;
        try {
          const frame = frameParts.length === 1 ? frameParts[0]! : Buffer.concat(frameParts, frameBytes);
          options.onFrame(frame);
        } catch (error) {
          failure = diagnosticText(error);
          halt("invalid_output");
        }
        frameParts = [];
        frameBytes = 0;
        offset = end + 1;
      }
    });
    child.stdout!.on("end", () => {
      if (!stop && frameBytes > 0) {
        failure = "Ripgrep returned an incomplete protocol record.";
        halt("invalid_output");
      }
    });
    child.stdout!.on("error", failed);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.stderr!.on("error", failed);
    child.on("error", failed);
    child.once("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      const diagnostic = [failure, Buffer.concat(stderr, stderrBytes).toString("utf8"), signal && !stop ? `Ripgrep exited on signal ${signal}.` : ""].filter(Boolean).join("\n");
      resolve({ code, stop: options.signal?.aborted ? "cancelled" : stop, diagnostic });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function diagnosticText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
