/**
 * Tool worker script — runs inside a forked child process.
 *
 * Receives via IPC: { handlerPath, params, context }
 * Sends via IPC:    { success, output, error, durationMs }
 *
 * This file is the entry point for child_process.fork().
 */

interface WorkerMessage {
  readonly handlerPath: string;
  readonly params: Record<string, unknown>;
  readonly context: {
    readonly sessionId: string;
    readonly capabilities: readonly string[];
    readonly scratchDir: string;
    readonly timeout: number;
  };
}

interface WorkerResult {
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Capture stdout/stderr
const capturedStdout: string[] = [];
const capturedStderr: string[] = [];

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk: string | Uint8Array): boolean => {
  capturedStdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  return true;
};

process.stderr.write = (chunk: string | Uint8Array): boolean => {
  capturedStderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  return true;
};

process.on("message", async (msg: WorkerMessage) => {
  const startTime = Date.now();

  try {
    // Dynamically import the handler module
    const handlerModule = await import(msg.handlerPath) as Record<string, unknown>;
    const handler = handlerModule["default"] as { execute?: (params: Record<string, unknown>, context: unknown) => Promise<unknown> } | undefined;

    if (!handler?.execute || typeof handler.execute !== "function") {
      sendResult({
        success: false,
        output: null,
        error: "Handler module does not export a valid execute function",
        durationMs: Date.now() - startTime,
        stdout: capturedStdout.join(""),
        stderr: capturedStderr.join(""),
      });
      return;
    }

    const result = await handler.execute(msg.params, msg.context) as {
      success: boolean;
      output: unknown;
      error?: string;
      durationMs: number;
    };

    sendResult({
      success: result.success,
      output: result.output,
      error: result.error,
      durationMs: Date.now() - startTime,
      stdout: capturedStdout.join(""),
      stderr: capturedStderr.join(""),
    });
  } catch (err) {
    sendResult({
      success: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      stdout: capturedStdout.join(""),
      stderr: capturedStderr.join(""),
    });
  }
});

function sendResult(result: WorkerResult): void {
  if (process.send) {
    process.send(result);
  }
  // Exit cleanly after sending result
  setTimeout(() => process.exit(0), 50);
}

// Signal readiness
if (process.send) {
  process.send({ ready: true });
}
