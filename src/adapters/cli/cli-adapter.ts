import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { SLASH_COMMANDS } from "../../router/message-router.js";
import type {
  InboundMessage,
  OutboundMessage,
  StreamableChannelAdapter,
  StreamableResponse,
} from "../../types.js";
import { sage, clay, lavender, rose, stone, amber, bold, dim, glyphs } from "../../utils/ansi.js";
import { toErrorMessage } from "../../utils/errors.js";
import { renderMarkdown, StreamingMarkdownWriter } from "../../utils/terminal-markdown.js";

const PROMPT_PLAIN = `you ${glyphs.prompt} `;
const PROMPT_COLOR = clay(bold("you")) + clay(` ${glyphs.prompt} `);
const BOT_PREFIX = sage(bold("bot")) + sage(` ${glyphs.prompt} `);

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class CliAdapter implements StreamableChannelAdapter {
  readonly id = "cli";
  readonly name = "CLI";
  private callback: ((msg: InboundMessage) => void) | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private activeStreams = 0;
  private streamChain: Promise<void> = Promise.resolve();
  private scrollRegionActive = false;

  /** Get terminal height, falling back to 24 rows. */
  private getRows(): number {
    return process.stdout.rows ?? 24;
  }

  /**
   * Activate a scroll region that reserves the bottom 2 lines for user input.
   * Output writes go into the scrollable area above; the prompt stays fixed.
   */
  private enterScrollRegion(): void {
    if (this.scrollRegionActive || !process.stdin.isTTY) return;
    const rows = this.getRows();
    // Set scroll region to rows 1..(rows-2), leaving 2 lines for prompt + separator
    process.stdout.write(`\x1b[1;${rows - 2}r`);
    // Move cursor into the scroll region
    process.stdout.write(`\x1b[${rows - 2};1H`);
    // Draw separator and prompt on fixed bottom lines
    this.drawInputArea();
    // Move cursor back into scroll region for output
    process.stdout.write(`\x1b[${rows - 2};1H`);
    this.scrollRegionActive = true;
  }

  /** Reset scroll region to full terminal. */
  private exitScrollRegion(): void {
    if (!this.scrollRegionActive) return;
    process.stdout.write("\x1b[?25h"); // ensure cursor visible
    // Reset scroll region to full terminal
    process.stdout.write("\x1b[r");
    // Move to bottom
    const rows = this.getRows();
    process.stdout.write(`\x1b[${rows};1H`);
    // Clear the separator and old prompt lines
    process.stdout.write("\x1b[2K");
    process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K`);
    this.scrollRegionActive = false;
  }

  /** Draw the fixed input area on the bottom 2 lines (separator + prompt). */
  private drawInputArea(): void {
    const rows = this.getRows();
    // Save cursor position in scroll region
    process.stdout.write("\x1b[s");
    // Move to separator line (row - 1) and draw thin divider
    process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K`);
    const cols = process.stdout.columns ?? 80;
    process.stdout.write(stone(dim(glyphs.hRule.repeat(cols))));
    // Move to input line (bottom row) and draw prompt
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write(PROMPT_COLOR);
    // Restore cursor to scroll region
    process.stdout.write("\x1b[u");
  }

  /** Refresh the prompt text on the input line (during streaming). */
  private refreshInputLine(): void {
    if (!this.scrollRegionActive) return;
    const rows = this.getRows();
    const currentLine = (this.rl as unknown as { line: string }).line ?? "";
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write(PROMPT_COLOR + currentLine);
    process.stdout.write("\x1b[u");
  }

  /** Display the colored prompt. Readline gets the plain version for cursor math. */
  private showPrompt(): void {
    this.rl?.setPrompt(PROMPT_PLAIN);
    this.rl?.prompt();
    process.stdout.write("\r" + PROMPT_COLOR);
  }

  /** Re-apply colored prompt after readline redraws (e.g. on backspace). */
  private recolorPrompt(): void {
    process.stdout.write("\x1b[s\x1b[0G" + PROMPT_COLOR + "\x1b[u");
  }

  private hintLines = 0;

  private clearHint(): void {
    if (this.hintLines === 0) return;
    let seq = "";
    for (let i = 0; i < this.hintLines; i++) seq += "\x1b[1B\x1b[2K";
    for (let i = 0; i < this.hintLines; i++) seq += "\x1b[1A";
    process.stdout.write(seq);
    this.hintLines = 0;
  }

  private showHint(): void {
    const line = (this.rl as unknown as { line: string }).line ?? "";
    this.clearHint();
    if (!line.startsWith("/") || line.includes(" ") || line.length === 0) return;

    const q = line.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
    if (matches.length === 0) return;

    const hintItems = matches.slice(0, 4);
    // Save cursor, move down, write hints, restore cursor
    const hint = hintItems
      .map((c) => stone(`  ${c.name}`) + (c.args ? stone(dim(` ${c.args}`)) : "") + stone(dim(` — ${c.description}`)))
      .join("\n");
    process.stdout.write("\x1b[s\n" + hint + "\x1b[u");
    this.hintLines = hintItems.length;
  }

  /** Start an animated spinner. Returns a function that stops and clears it. */
  private startSpinner(label: string): () => void {
    let frame = 0;
    if (this.scrollRegionActive) process.stdout.write("\x1b[?25l"); // hide cursor
    const id = setInterval(() => {
      const char = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋";
      process.stdout.write(`\r\x1b[2K  ${stone(char)} ${stone(dim(label))}`);
      frame++;
    }, 80);
    // Write first frame immediately
    process.stdout.write(`\r\x1b[2K  ${stone("⠋")} ${stone(dim(label))}`);
    return () => {
      clearInterval(id);
      process.stdout.write("\r\x1b[2K");
      if (this.scrollRegionActive) process.stdout.write("\x1b[?25h"); // show cursor
    };
  }

  async start(): Promise<void> {
    const commandNames = SLASH_COMMANDS.map((c) => c.name);

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT_PLAIN,
      completer: (line: string): [string[], string] => {
        if (!line.startsWith("/")) return [[], line];
        const hits = commandNames.filter((n) => n.startsWith(line));
        return [hits, line];
      },
    });

    // Update scroll region on terminal resize
    if (process.stdout.isTTY) {
      process.stdout.on("resize", () => {
        if (this.scrollRegionActive) {
          const rows = this.getRows();
          process.stdout.write(`\x1b[1;${rows - 2}r`);
          this.drawInputArea();
        }
      });
    }

    // Re-apply prompt color and show command hints as user types
    if (process.stdin.isTTY) {
      process.stdin.on("data", () => {
        setImmediate(() => {
          if (this.scrollRegionActive) {
            this.refreshInputLine();
            return;
          }
          this.recolorPrompt();
          this.showHint();
        });
      });
    }

    this.showPrompt();

    this.rl.on("line", (line) => {
      this.clearHint();
      const text = line.trim();
      if (!text) {
        if (this.scrollRegionActive) {
          this.refreshInputLine();
        } else {
          this.showPrompt();
        }
        return;
      }

      // During streaming, clear the input line after submit and redraw prompt
      if (this.scrollRegionActive) {
        this.refreshInputLine();
      }

      const msg: InboundMessage = {
        id: randomUUID(),
        adapterId: "cli",
        channelId: "cli:local",
        senderId: "local-user",
        text,
        timestamp: Date.now(),
      };

      this.callback?.(msg);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(_channelId: string, message: OutboundMessage): Promise<void> {
    const rendered = renderMarkdown(message.text);
    process.stdout.write("\n" + BOT_PREFIX + rendered + "\n\n");
    this.showPrompt();
  }

  async sendStream(_channelId: string, response: StreamableResponse): Promise<void> {
    this.activeStreams++;
    const prev = this.streamChain;
    this.streamChain = prev.then(() =>
      this.doSendStream(_channelId, response).catch((err) => {
        const msg = toErrorMessage(err);
        process.stderr.write(rose(`  stream error: ${msg}`) + "\n");
      })
    );
    await this.streamChain;
    this.activeStreams--;
  }

  private async doSendStream(_channelId: string, response: StreamableResponse): Promise<void> {
    this.enterScrollRegion();

    let wrotePrefix = false;
    const md = new StreamingMarkdownWriter((text) => {
      if (!wrotePrefix) {
        process.stdout.write("\n" + BOT_PREFIX);
        wrotePrefix = true;
      }
      process.stdout.write(text);
    });

    let stopProcessing: (() => void) | null = this.startSpinner("Processing...");
    let stopThinking: (() => void) | null = null;

    const clearSpinners = (): void => {
      if (stopProcessing) { stopProcessing(); stopProcessing = null; }
      if (stopThinking) { stopThinking(); stopThinking = null; }
    };

    try {
      for await (const event of response.stream) {
        switch (event.type) {
          case "text-delta":
            clearSpinners();
            md.push(event.delta);
            break;

          case "reasoning-delta":
            if (stopProcessing) { stopProcessing(); stopProcessing = null; }
            if (!stopThinking) {
              stopThinking = this.startSpinner("Thinking...");
            }
            break;

          case "tool-start":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + lavender(dim(`  ${glyphs.tool} ` + event.toolCall.function.name + "...")) + "\n");
            wrotePrefix = false;
            // Restart processing spinner while tool executes
            stopProcessing = this.startSpinner("Processing...");
            break;

          case "tool-result":
            if (stopProcessing) { stopProcessing(); stopProcessing = null; }
            if (event.error) {
              process.stdout.write(rose(`  ${glyphs.fail} ` + event.toolName + " failed") + "\n");
            } else {
              process.stdout.write(lavender(dim(`  ${glyphs.ok} ` + event.toolName)) + "\n");
            }
            wrotePrefix = false;
            break;

          case "warning":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + amber(`  ${glyphs.warn} ` + event.message) + "\n");
            wrotePrefix = false;
            break;

          case "error":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + rose(bold("  error ")) + rose(event.message) + "\n");
            break;

          case "reset":
            clearSpinners();
            md.flush();
            // Clear terminal and move cursor home
            process.stdout.write("\x1b[2J\x1b[H");
            wrotePrefix = false;
            break;

          case "done": {
            clearSpinners();
            md.flush();
            if (event.context) {
              const used = event.context.actualTokens ?? event.context.estimatedTokens;
              const usedK = (used / 1000).toFixed(1);
              const maxK = (event.context.budget / 1000).toFixed(1);
              process.stdout.write(stone(dim(`  ${usedK}k / ${maxK}k context`)) + "\n");
            }
            break;
          }
        }
      }
    } finally {
      clearSpinners();
      md.flush();
      this.exitScrollRegion();
    }

    process.stdout.write("\n\n");
    this.showPrompt();
  }
}
