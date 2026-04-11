import type { Logger } from "pino";
import type { GatewayConfig } from "./config/types.js";
import { setMessageStore } from "./channels/telegram/handlers.js";
import { MessageStore } from "./sessions/message-store.js";
import { ProcessManager } from "./process/manager.js";
import { resolveDataDir, resolveBots, loadConfig } from "./config/loader.js";
import { ApiServer } from "./api/server.js";
import { BotInstance } from "./bot-instance.js";
import { join } from "node:path";
import { mkdirSync, watch, type FSWatcher } from "node:fs";

export class Gateway {
  private config: GatewayConfig;
  private log: Logger;
  private processManager: ProcessManager;
  private apiServer?: ApiServer;
  private messageStore: MessageStore;
  private bots = new Map<string, BotInstance>();
  private dataDir: string;
  private configPath: string;
  private configWatcher?: FSWatcher;

  constructor(config: GatewayConfig, log: Logger, configPath?: string) {
    this.config = config;
    this.log = log;
    this.dataDir = resolveDataDir(config);
    this.configPath = configPath ?? join(this.dataDir, "config.yaml");

    // Shared message store (module-level singleton for handlers.ts)
    this.messageStore = new MessageStore(this.dataDir);
    setMessageStore(this.messageStore);

    // Build base extraArgs from top-level config (no per-bot model here)
    const extraArgs = [...config.claude.extraArgs];
    if (config.claude.model) {
      extraArgs.push("--model", config.claude.model);
    }

    const workspaceDir = join(this.dataDir, "workspace");
    const agentsDir = join(this.dataDir, "agents");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });

    // Shared process manager
    this.processManager = new ProcessManager(
      {
        binary: config.claude.binary,
        idleTimeoutMs: config.claude.idleTimeoutMs,
        maxProcesses: config.claude.maxProcesses,
        extraArgs,
        workspaceDir,
        apiPort: config.gateway.port,
        agentsDir,
      },
      log,
    );

    // Resolve bot configs and create BotInstance for each
    const botConfigs = resolveBots(config);
    for (const botConfig of botConfigs) {
      const bot = new BotInstance({
        botConfig,
        gatewayConfig: config,
        processManager: this.processManager,
        messageStore: this.messageStore,
        dataDir: this.dataDir,
        log,
      });
      this.bots.set(bot.botId, bot);
    }

    if (this.bots.size === 0) {
      this.log.warn("No bots configured. Check config.yaml for bots or channels.telegram.");
    }
  }

  async reloadConfig(): Promise<{ ok: boolean; changes: string[] }> {
    try {
      const newConfig = loadConfig(this.configPath);
      const changes: string[] = [];

      // Claude process config (applies to newly spawned processes)
      const extraArgs = [...newConfig.claude.extraArgs];
      if (newConfig.claude.model) extraArgs.push("--model", newConfig.claude.model);

      if (newConfig.claude.model !== this.config.claude.model) {
        changes.push(`model: ${this.config.claude.model ?? "default"} -> ${newConfig.claude.model ?? "default"}`);
      }
      if (newConfig.claude.maxProcesses !== this.config.claude.maxProcesses) {
        changes.push(`maxProcesses: ${this.config.claude.maxProcesses} -> ${newConfig.claude.maxProcesses}`);
      }
      if (newConfig.claude.idleTimeoutMs !== this.config.claude.idleTimeoutMs) {
        changes.push(`idleTimeoutMs: ${this.config.claude.idleTimeoutMs} -> ${newConfig.claude.idleTimeoutMs}`);
      }

      this.processManager.updateConfig({
        binary: newConfig.claude.binary,
        idleTimeoutMs: newConfig.claude.idleTimeoutMs,
        maxProcesses: newConfig.claude.maxProcesses,
        extraArgs,
      });

      // Log level
      if (newConfig.gateway.logLevel !== this.config.gateway.logLevel) {
        changes.push(`logLevel: ${this.config.gateway.logLevel} -> ${newConfig.gateway.logLevel}`);
        this.log.level = newConfig.gateway.logLevel;
      }

      // --- Dynamic bot add/remove ---
      const newBotConfigs = resolveBots(newConfig);
      const newBotIds = new Set(newBotConfigs.map(b => b.botId));
      const currentBotIds = new Set(this.bots.keys());

      // Stop removed bots
      for (const botId of currentBotIds) {
        if (!newBotIds.has(botId)) {
          const bot = this.bots.get(botId)!;
          this.log.info({ botId, botName: bot.name }, "Stopping removed bot");
          await bot.stop();
          this.bots.delete(botId);
          changes.push(`bot removed: ${bot.name} (${botId})`);
        }
      }

      // Start newly added bots
      for (const botConfig of newBotConfigs) {
        if (!currentBotIds.has(botConfig.botId)) {
          const bot = new BotInstance({
            botConfig,
            gatewayConfig: newConfig,
            processManager: this.processManager,
            messageStore: this.messageStore,
            dataDir: this.dataDir,
            log: this.log,
          });
          this.bots.set(bot.botId, bot);
          await bot.start();
          this.log.info({ botId: bot.botId, botName: bot.name }, "Started new bot");
          changes.push(`bot added: ${bot.name} (${bot.botId})`);
        }
      }

      // Update allowed chat IDs from all bots
      const newAllowedChatIds = new Set<string>();
      for (const bot of this.bots.values()) {
        for (const chatId of bot.getGroupChatIds()) {
          newAllowedChatIds.add(chatId);
        }
      }
      this.apiServer?.updateAllowedChatIds(newAllowedChatIds);

      // Refresh allowFrom for each bot
      this.config = newConfig;
      for (const bot of this.bots.values()) {
        bot.refreshAllowFrom();
      }

      if (changes.length === 0) changes.push("no changes detected");
      this.log.info({ changes }, "Config reloaded");
      return { ok: true, changes };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ error: msg }, "Config reload failed");
      return { ok: false, changes: [`error: ${msg}`] };
    }
  }

  private setupConfigWatcher(): void {
    let debounceTimer: NodeJS.Timeout | undefined;
    try {
      this.configWatcher = watch(this.configPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.log.info("Config file changed, reloading...");
          this.reloadConfig().catch((err) => {
            this.log.error({ error: err instanceof Error ? err.message : String(err) }, "Config reload error");
          });
        }, 500);
      });
      this.log.info({ path: this.configPath }, "Watching config for changes");
    } catch (err) {
      this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to watch config file");
    }
  }

  /** Set up bot-to-bot relay: when a bot sends a message containing @another_bot, relay it */
  private setupBotRelay(): void {
    // Build username → BotInstance lookup
    const botsByUsername = new Map<string, BotInstance>();
    for (const bot of this.bots.values()) {
      const username = bot.telegram.username;
      if (username) {
        botsByUsername.set(username.toLowerCase(), bot);
      }
    }

    for (const sourceBot of this.bots.values()) {
      sourceBot.telegram.onOutbound((chatId, text, messageId) => {
        // Only relay in group chats
        if (!chatId.startsWith("-")) return;

        // Rebuild username map in case new bots started after initial setup
        for (const b of this.bots.values()) {
          const u = b.telegram.username;
          if (u) botsByUsername.set(u.toLowerCase(), b);
        }

        // Check for @mentions of other bots
        for (const [username, targetBot] of botsByUsername) {
          if (targetBot.botId === sourceBot.botId) continue;
          if (!text.includes(`@${username}`)) continue;

          // Strip the @mention from text for the target bot
          const cleanText = text.replace(new RegExp(`@${username}`, "gi"), "").trim();
          if (!cleanText) continue;

          this.log.info(
            { from: sourceBot.name, to: targetBot.name, chatId },
            "Relaying bot-to-bot message",
          );

          targetBot.relayMessage({
            channelType: "telegram",
            chatId,
            senderId: sourceBot.botId,
            senderName: sourceBot.name,
            messageId,
            text: cleanText,
            isGroup: true,
            timestamp: Math.floor(Date.now() / 1000),
            raw: { relayedFrom: sourceBot.botId },
          });
        }
      });
    }
  }

  async start(): Promise<void> {
    this.log.info("Starting gateway...");

    // Start all bot instances
    for (const bot of this.bots.values()) {
      await bot.start();
      this.log.info({ botId: bot.botId, botName: bot.name }, "Bot started");
    }

    // Set up bot-to-bot relay after all bots have started (so usernames are populated)
    this.setupBotRelay();

    // Collect all group chat IDs from all bots for API server
    const allowedChatIds = new Set<string>();
    for (const bot of this.bots.values()) {
      for (const chatId of bot.getGroupChatIds()) {
        allowedChatIds.add(chatId);
      }
    }

    // Start API server with getBotTelegram lookup across all bots
    this.apiServer = new ApiServer({
      port: this.config.gateway.port,
      getBotTelegram: (botId) => this.bots.get(botId)?.telegram,
      dataDir: this.dataDir,
      log: this.log,
      messageStore: this.messageStore,
      allowedChatIds,
      onReloadConfig: () => this.reloadConfig(),
    });
    await this.apiServer.start();

    this.setupConfigWatcher();
    this.log.info({ botCount: this.bots.size }, "Gateway started");
  }

  async stop(): Promise<void> {
    this.log.info("Stopping gateway...");
    this.configWatcher?.close();
    await this.apiServer?.stop();

    // Stop all bot instances
    for (const bot of this.bots.values()) {
      await bot.stop();
    }

    await this.processManager.shutdown();
    this.log.info("Gateway stopped");
  }

  /** Get the pairing manager for a specific bot (used by CLI commands) */
  getPairingManager(): import("./auth/pairing.js").PairingManager | undefined {
    // For backward compat, return the first bot's pairing manager
    const first = this.bots.values().next();
    return first.done ? undefined : first.value.getPairingManager();
  }

  /** Approve a pairing code across all bots (used by CLI commands) */
  approvePairing(code: string): { senderId: string } | null {
    for (const bot of this.bots.values()) {
      const result = bot.approvePairing(code);
      if (result) return result;
    }
    return null;
  }
}
