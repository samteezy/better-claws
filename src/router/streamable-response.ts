import type { StreamEvent, StreamableResponse as IStreamableResponse } from "../types.js";

interface DeferredPromises {
  resolveText: (v: string) => void;
  rejectText: (e: unknown) => void;
  resolveReasoning: (v: string | undefined) => void;
  rejectReasoning: (e: unknown) => void;
  resolveUsage: (v: { readonly promptTokens: number; readonly completionTokens: number }) => void;
  rejectUsage: (e: unknown) => void;
  resolveWarnings: (v: readonly string[]) => void;
  rejectWarnings: (e: unknown) => void;
}

/**
 * Wraps an async generator of StreamEvents, providing both an async iterable
 * for chunk-by-chunk consumption and promise-based accessors for the final
 * aggregated result (inspired by Vercel AI SDK's streamText pattern).
 *
 * The constructor kicks off a background reader that drains the source generator
 * into an internal buffer. Consumers iterate `stream` to pull events out of
 * that buffer. If nobody iterates, the background reader still completes and
 * resolves `.text` / `.usage`.
 */
export class StreamableResponse implements IStreamableResponse {
  readonly stream: AsyncIterable<StreamEvent>;
  readonly text: Promise<string>;
  readonly reasoning: Promise<string | undefined>;
  readonly usage: Promise<{ readonly promptTokens: number; readonly completionTokens: number }>;
  readonly warnings: Promise<readonly string[]>;

  constructor(
    source: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
    onComplete?: (event: StreamEvent & { type: "done" }) => void | Promise<void>,
  ) {
    // Internal buffer + signalling
    const buffer: StreamEvent[] = [];
    let finished = false;
    const signal = { notify: null as (() => void) | null };
    const collectedWarnings: string[] = [];

    // Deferred promise wiring
    const deferred: DeferredPromises = {
      resolveText: (_v: string): void => {},
      rejectText: (_e: unknown): void => {},
      resolveReasoning: (_v: string | undefined): void => {},
      rejectReasoning: (_e: unknown): void => {},
      resolveUsage: (_v: { readonly promptTokens: number; readonly completionTokens: number }): void => {},
      rejectUsage: (_e: unknown): void => {},
      resolveWarnings: (_v: readonly string[]): void => {},
      rejectWarnings: (_e: unknown): void => {},
    };

    const textPromise = new Promise<string>((res, rej) => {
      deferred.resolveText = res;
      deferred.rejectText = rej;
    });
    const reasoningPromise = new Promise<string | undefined>((res, rej) => {
      deferred.resolveReasoning = res;
      deferred.rejectReasoning = rej;
    });
    const usagePromise = new Promise<{ readonly promptTokens: number; readonly completionTokens: number }>((res, rej) => {
      deferred.resolveUsage = res;
      deferred.rejectUsage = rej;
    });
    const warningsPromise = new Promise<readonly string[]>((res, rej) => {
      deferred.resolveWarnings = res;
      deferred.rejectWarnings = rej;
    });

    // Prevent unhandled rejection warnings when only .text is consumed
    reasoningPromise.catch(() => {});
    usagePromise.catch(() => {});
    warningsPromise.catch(() => {});

    this.text = textPromise;
    this.reasoning = reasoningPromise;
    this.usage = usagePromise;
    this.warnings = warningsPromise;

    // Background reader: drains source into buffer, resolves promises on completion
    void (async () => {
      try {
        for await (const event of source) {
          buffer.push(event);
          signal.notify?.();

          if (event.type === "warning") {
            collectedWarnings.push(event.message);
          }

          if (event.type === "done") {
            if (onComplete) {
              await onComplete(event);
            }
            deferred.resolveText(event.text);
            deferred.resolveReasoning(event.reasoning);
            deferred.resolveUsage(event.usage);
            deferred.resolveWarnings(collectedWarnings);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream failed";
        deferred.rejectText(err);
        deferred.rejectReasoning(err);
        deferred.rejectUsage(err);
        deferred.rejectWarnings(err);
        buffer.push({ type: "error", message: msg });
      } finally {
        finished = true;
        signal.notify?.();
      }
    })();

    // Async iterable that reads from the buffer with backpressure
    this.stream = {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        let readIndex = 0;

        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            while (readIndex >= buffer.length) {
              if (finished) {
                // Drain any remaining buffered events
                if (readIndex < buffer.length) continue;
                return { done: true, value: undefined };
              }
              // Wait for the background reader to push more events
              await new Promise<void>((resolve) => {
                signal.notify = resolve;
              });
            }

            const value = buffer[readIndex]!;
            readIndex++;
            return { done: false, value };
          },
        };
      },
    };
  }

  /**
   * Creates a StreamableResponse from a fixed text (for command responses
   * like /new, /reset that don't need streaming).
   */
  static fromText(text: string): StreamableResponse {
    async function* single(): AsyncGenerator<StreamEvent> {
      if (text.length > 0) {
        yield { type: "text-delta", delta: text };
      }
      yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
    }
    return new StreamableResponse(single());
  }
}
