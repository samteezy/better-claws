import type { StreamEvent, StreamableResponse as IStreamableResponse } from "../types.js";

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
  readonly usage: Promise<{ readonly promptTokens: number; readonly completionTokens: number }>;

  constructor(
    source: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
    onComplete?: (event: StreamEvent & { type: "done" }) => void | Promise<void>,
  ) {
    // Internal buffer + signalling
    const buffer: StreamEvent[] = [];
    let finished = false;
    const signal = { notify: null as (() => void) | null };

    // Deferred promise wiring
    const deferred = {
      resolveText: (_v: string): void => {},
      rejectText: (_e: unknown): void => {},
      resolveUsage: (_v: { readonly promptTokens: number; readonly completionTokens: number }): void => {},
      rejectUsage: (_e: unknown): void => {},
    };

    const textPromise = new Promise<string>((res, rej) => {
      deferred.resolveText = res;
      deferred.rejectText = rej;
    });
    const usagePromise = new Promise<{ readonly promptTokens: number; readonly completionTokens: number }>((res, rej) => {
      deferred.resolveUsage = res;
      deferred.rejectUsage = rej;
    });

    // Prevent unhandled rejection warnings when only .text is consumed
    usagePromise.catch(() => {});

    this.text = textPromise;
    this.usage = usagePromise;

    // Background reader: drains source into buffer, resolves promises on completion
    void (async () => {
      try {
        for await (const event of source) {
          buffer.push(event);
          signal.notify?.();

          if (event.type === "done") {
            if (onComplete) {
              await onComplete(event);
            }
            deferred.resolveText(event.text);
            deferred.resolveUsage(event.usage);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream failed";
        deferred.rejectText(err);
        deferred.rejectUsage(err);
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
