import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import https from "node:https";
import type { Logger } from "pino";

// Force IPv4 to avoid IPv6 ENETUNREACH causing IPv4 timeout on dual-stack hosts
const ipv4Agent = new https.Agent({ family: 4 });

export function createBot(token: string, log: Logger): Bot {
  const bot = new Bot(token, {
    client: {
      baseFetchConfig: { agent: ipv4Agent },
    },
  });
  bot.api.config.use(apiThrottler());
  bot.catch((err) => {
    log.error({ error: err.message }, "Bot error");
  });
  return bot;
}
