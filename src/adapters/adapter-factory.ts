import type { AdapterConfig, ChannelAdapter } from "../types.js";
import { ConfigError } from "../config.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { TelegramAdapter } from "./telegram/telegram-adapter.js";
import { DiscordAdapter } from "./discord/discord-adapter.js";
import { SlackAdapter } from "./slack/slack-adapter.js";
import { WebhookAdapter } from "./webhook/webhook-adapter.js";
import { SignalAdapter } from "./signal/signal-adapter.js";
import { WebChatAdapter } from "./webchat/webchat-adapter.js";

function requireFields(
  name: string,
  config: AdapterConfig,
  fields: readonly string[],
): void {
  const missing = fields.filter(
    (f) => !((config as unknown as Record<string, unknown>)[f]),
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `Adapter '${name}' requires '${missing.join("', '")}'`,
      "MISSING_ADAPTER_CONFIG",
    );
  }
}

export function createAdapter(
  name: string,
  config: AdapterConfig,
  logger: StructuredLogger,
): ChannelAdapter {
  switch (name) {
    case "telegram":
      requireFields(name, config, ["token"]);
      return new TelegramAdapter({ token: config.token!, logger });

    case "discord":
      requireFields(name, config, ["token"]);
      return new DiscordAdapter({ token: config.token!, logger });

    case "slack":
      requireFields(name, config, ["token", "secret"]);
      return new SlackAdapter({
        token: config.token!,
        appToken: config.secret!,
        logger,
      });

    case "webhook":
      requireFields(name, config, ["secret", "port"]);
      return new WebhookAdapter({
        secret: config.secret!,
        port: config.port!,
        host: config.host,
        path: config.path,
        logger,
      });

    case "signal":
      requireFields(name, config, ["apiUrl", "number"]);
      return new SignalAdapter({
        apiUrl: config.apiUrl!,
        number: config.number!,
        mode: config.mode,
        logger,
      });

    case "webchat":
      requireFields(name, config, ["port"]);
      return new WebChatAdapter({
        port: config.port!,
        host: config.host,
        authToken: config.secret,
        logger,
      });

    default:
      throw new ConfigError(
        `Unknown adapter '${name}'`,
        "UNKNOWN_ADAPTER",
      );
  }
}
