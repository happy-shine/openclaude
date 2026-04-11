#!/usr/bin/env node

import { Command } from "commander";
import pino from "pino";
import { loadConfig, resolveBots } from "./config/loader.js";
import type { GatewayConfig } from "./config/types.js";
import { Gateway } from "./gateway.js";
import { PairingManager } from "./auth/pairing.js";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { parseDocument } from "yaml";

const program = new Command();

program
  .name("openclaude")
  .description("Gateway bridging chat platforms to Claude Code CLI")
  .version("0.1.0");

/** Resolve the data directory from config or default */
function getDataDir(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolve(config.gateway.dataDir.replace(/^~/, process.env.HOME ?? ""));
  } catch {
    return resolve(process.env.HOME ?? "~", ".openclaude");
  }
}

/** Resolve logs directory and ensure it exists */
function getLogDir(dataDir: string): string {
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Resolve a bot by name (or default if only one configured) */
function resolveBotId(config: GatewayConfig, botName?: string): { botId: string; name: string } {
  const bots = resolveBots(config);
  if (bots.length === 0) {
    console.error("No bots configured");
    process.exit(1);
  }
  if (botName) {
    const bot = bots.find(b => b.name === botName || b.botId === botName);
    if (!bot) {
      console.error(`Bot "${botName}" not found. Available: ${bots.map(b => b.name).join(", ")}`);
      process.exit(1);
    }
    return { botId: bot.botId, name: bot.name };
  }
  if (bots.length === 1) {
    return { botId: bots[0].botId, name: bots[0].name };
  }
  console.error(`Multiple bots configured. Specify --bot <name>: ${bots.map(b => b.name).join(", ")}`);
  process.exit(1);
}

/** Read the lock file and return PID if process is alive */
function getRunningPid(dataDir: string): number | null {
  const lockPath = join(dataDir, "gateway.lock");
  if (!existsSync(lockPath)) return null;
  try {
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData.pid, 0); // throws if dead
    return lockData.pid;
  } catch {
    // stale or invalid lock
    try { unlinkSync(lockPath); } catch {}
    return null;
  }
}

// Clawd mascot poses — ported from Claude Code src/components/LogoV2/Clawd.tsx
const CLAWD_POSES = [
  // default
  [" ▐▛███▜▌  ", "▝▜█████▛▘ ", "  ▘▘ ▝▝   "],
  // arms-up
  ["▗▟▛███▜▙▖ ", " ▜█████▛  ", "  ▘▘ ▝▝   "],
  // look-left
  [" ▐▟███▟▌  ", "▝▜█████▛▘ ", "  ▘▘ ▝▝   "],
  // look-right
  [" ▐▙███▙▌  ", "▝▜█████▛▘ ", "  ▘▘ ▝▝   "],
];

function printBanner(): void {
  const pose = CLAWD_POSES[Math.floor(Math.random() * CLAWD_POSES.length)];
  console.log("");
  console.log(`  ${pose[0]} OpenClaude v0.1.0`);
  console.log(`  ${pose[1]} Claude Code Gateway`);
  console.log(`  ${pose[2]}`);
  console.log("");
}

/** Check if Claude Code CLI is installed and accessible */
function checkClaudeCli(configPath?: string): void {
  let binary = "claude";
  try {
    const config = loadConfig(configPath);
    if (config.claude.binary) binary = config.claude.binary;
  } catch {}

  const result = spawnSync(binary, ["--version"], { stdio: "pipe", timeout: 5000 });
  if (result.error || result.status !== 0) {
    console.error(`Error: Claude Code CLI not found ("${binary}").`);
    console.error("");
    console.error("OpenClaude requires Claude Code CLI as its engine.");
    console.error("Install it with:");
    console.error("");
    console.error("  npm install -g @anthropic-ai/claude-code");
    console.error("");
    console.error("Then authenticate:");
    console.error("");
    console.error("  claude");
    console.error("");
    console.error("Docs: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  const version = result.stdout?.toString().trim();
  if (version) {
    console.log(`Claude Code CLI: ${version}`);
  }
}

// --- gateway ---
const gateway = program.command("gateway").description("Manage the gateway daemon");

gateway
  .command("start")
  .description("Start the gateway")
  .option("-c, --config <path>", "Path to config file")
  .option("-v, --verbose", "Enable debug logging")
  .option("-f, --foreground", "Run in foreground (default: background daemon)")
  .action(async (opts: { config?: string; verbose?: boolean; foreground?: boolean }) => {
    checkClaudeCli(opts.config);
    const dataDir = getDataDir(opts.config);

    // Check if already running
    const existingPid = getRunningPid(dataDir);
    if (existingPid) {
      console.error(`Gateway already running (PID ${existingPid}). Use 'openclaude gateway restart' to restart.`);
      process.exit(1);
    }

    // Background mode (default)
    if (!opts.foreground) {
      const logDir = getLogDir(dataDir);
      const logFile = join(logDir, "gateway.log");

      const args = [process.argv[1], "gateway", "start", "--foreground"];
      if (opts.config) args.push("--config", opts.config);
      if (opts.verbose) args.push("--verbose");

      const out = createWriteStream(logFile, { flags: "a" });
      await new Promise<void>((r) => out.on("open", r));
      const child = spawn(process.argv[0], args, {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
      });

      child.unref();

      // Wait briefly to check if process started OK
      await new Promise((r) => setTimeout(r, 1000));

      try {
        process.kill(child.pid!, 0);
        printBanner();
        console.log(`  Gateway started (PID ${child.pid})`);
        console.log(`  Logs: ${logFile}`);
        console.log("");
      } catch {
        console.error("Gateway failed to start. Check logs:");
        console.error(`  tail -f ${logFile}`);
        process.exit(1);
      }

      process.exit(0);
    }

    // Foreground mode
    const configPath = opts.config ?? resolve(process.env.HOME ?? "~", ".openclaude", "config.yaml");
    const config = loadConfig(configPath);
    if (opts.verbose) config.gateway.logLevel = "debug";

    const logDir = getLogDir(dataDir);
    const logFile = join(logDir, "gateway.log");
    const isTTY = process.stdout.isTTY;

    const targets: pino.TransportTargetOptions[] = [
      // Always write JSON to file
      {
        target: "pino/file",
        options: { destination: logFile, mkdir: true },
        level: config.gateway.logLevel,
      },
    ];

    // Only add pretty console output if running in a real terminal
    if (isTTY) {
      targets.push({
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss" },
        level: config.gateway.logLevel,
      });
    }

    const log = pino({
      level: config.gateway.logLevel,
      transport: { targets },
    });

    const lockPath = join(resolve(dataDir), "gateway.lock");
    mkdirSync(resolve(dataDir), { recursive: true });

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );

    const gateway = new Gateway(config, log, configPath);

    const shutdown = async (signal: string) => {
      log.info({ signal }, "Received signal, shutting down...");
      await gateway.stop();
      try { unlinkSync(lockPath); } catch {}
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    try {
      await gateway.start();
    } catch (err) {
      log.fatal({ err }, "Failed to start gateway");
      try { unlinkSync(lockPath); } catch {}
      process.exit(1);
    }
  });

gateway
  .command("stop")
  .description("Stop the running gateway")
  .action(() => {
    const dataDir = getDataDir();
    const pid = getRunningPid(dataDir);
    if (!pid) {
      console.log("Gateway is not running.");
      return;
    }
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to gateway (PID ${pid}).`);

    // Wait for it to actually stop
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      try {
        process.kill(pid, 0);
        if (attempts > 10) {
          clearInterval(check);
          console.error("Gateway did not stop within 5s. Try: kill -9 " + pid);
        }
      } catch {
        clearInterval(check);
        printBanner();
        console.log("  Gateway stopped.");
        console.log("");
      }
    }, 500);
  });

gateway
  .command("restart")
  .description("Restart the gateway")
  .option("-c, --config <path>", "Path to config file")
  .option("-v, --verbose", "Enable debug logging")
  .action(async (opts: { config?: string; verbose?: boolean }) => {
    checkClaudeCli(opts.config);
    const dataDir = getDataDir(opts.config);
    const pid = getRunningPid(dataDir);

    if (pid) {
      console.log(`Stopping gateway (PID ${pid})...`);
      process.kill(pid, "SIGTERM");

      // Wait for stop
      await new Promise<void>((resolve) => {
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          try {
            process.kill(pid, 0);
            if (attempts > 20) {
              clearInterval(check);
              console.error("Force killing...");
              try { process.kill(pid, "SIGKILL"); } catch {}
              setTimeout(() => resolve(), 500);
            }
          } catch {
            clearInterval(check);
            resolve();
          }
        }, 500);
      });
      console.log("Gateway stopped.");
      // Wait a bit for port to be released
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Start again in background
    const logDir = getLogDir(dataDir);
    const logFile = join(logDir, "gateway.log");

    const args = [process.argv[1], "gateway", "start", "--foreground"];
    if (opts.config) args.push("--config", opts.config);
    if (opts.verbose) args.push("--verbose");

    const out = createWriteStream(logFile, { flags: "a" });
    await new Promise<void>((r) => out.on("open", r));
    const child = spawn(process.argv[0], args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
    });
    child.unref();

    await new Promise((r) => setTimeout(r, 1000));

    try {
      process.kill(child.pid!, 0);
      printBanner();
      console.log(`  Gateway restarted (PID ${child.pid})`);
      console.log(`  Logs: ${logFile}`);
      console.log("");
    } catch {
      console.error("Gateway failed to start. Check logs:");
      console.error(`  tail -f ${logFile}`);
      process.exit(1);
    }

    process.exit(0);
  });

gateway
  .command("status")
  .description("Check if gateway is running")
  .option("-c, --config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const dataDir = getDataDir(opts.config);
    const lockPath = join(dataDir, "gateway.lock");
    const logFile = join(dataDir, "logs", "gateway.log");

    if (!existsSync(lockPath)) {
      console.log("Gateway is not running.");
      return;
    }
    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
      try {
        process.kill(lockData.pid, 0);
        console.log(`Gateway running (PID ${lockData.pid})`);

        // Show configured bots
        try {
          const config = loadConfig(opts.config);
          const bots = resolveBots(config);
          if (bots.length > 0) {
            const botList = bots.map(b => `${b.name} (${b.botId})`).join(", ");
            console.log(`Bots: ${botList}`);
          }
        } catch {}

        if (existsSync(logFile)) {
          console.log(`Logs: ${logFile}`);
        }
      } catch {
        console.log("Gateway is not running (stale lock file).");
        unlinkSync(lockPath);
      }
    } catch {
      console.log("Gateway is not running (invalid lock file).");
    }
  });

gateway
  .command("logs")
  .description("Tail the gateway logs")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output", false)
  .action((opts: { lines: string; follow: boolean }) => {
    const dataDir = getDataDir();
    const logFile = join(dataDir, "logs", "gateway.log");

    if (!existsSync(logFile)) {
      console.log("No log file found. Start the gateway first.");
      return;
    }

    const args = ["-n", opts.lines];
    if (opts.follow) args.push("-f");
    args.push(logFile);

    const tail = spawn("tail", args, { stdio: "inherit" });
    tail.on("exit", (code) => process.exit(code ?? 0));
  });

// --- pairing ---
const pairing = program.command("pairing").description("Manage pairing requests");

pairing
  .command("list")
  .description("List pending pairing requests")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const pairingPath = join(dataDir, "credentials", botId, "telegram-pairing.json");
    if (!existsSync(pairingPath)) {
      console.log("No pending pairing requests.");
      return;
    }
    const pm = new PairingManager(pairingPath);
    const pending = pm.listPending();
    if (pending.length === 0) {
      console.log("No pending pairing requests.");
      return;
    }
    console.log("Pending pairing requests:\n");
    console.log("Code      Sender ID    Name         Channel    Requested");
    console.log("--------  -----------  -----------  ---------  ---------");
    for (const req of pending) {
      const age = formatAge(Date.now() - req.createdAt);
      console.log(
        `${req.code}  ${req.senderId.padEnd(11)}  ${req.senderName.padEnd(11)}  ${req.channelType.padEnd(9)}  ${age}`,
      );
    }
  });

pairing
  .command("approve")
  .description("Approve a pairing code")
  .argument("<code>", "Pairing code to approve")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name (auto-detected if omitted)")
  .action((code: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const bots = resolveBots(config);

    // Search across all bots (or specified bot) for the pairing code
    const searchBots = opts.bot
      ? [{ botId: resolveBotId(config, opts.bot).botId, name: resolveBotId(config, opts.bot).name }]
      : bots.map(b => ({ botId: b.botId, name: b.name }));

    for (const { botId, name } of searchBots) {
      const pairingPath = join(dataDir, "credentials", botId, "telegram-pairing.json");
      if (!existsSync(pairingPath)) continue;
      const pm = new PairingManager(pairingPath);
      const result = pm.approve(code);
      if (!result) continue;

      const allowPath = join(dataDir, "credentials", botId, "telegram-allowFrom.json");
      let allowFrom: string[] = [];
      if (existsSync(allowPath)) {
        try {
          allowFrom = JSON.parse(readFileSync(allowPath, "utf-8")).allowFrom ?? [];
        } catch {}
      }
      if (!allowFrom.includes(result.senderId)) {
        allowFrom.push(result.senderId);
        mkdirSync(join(dataDir, "credentials", botId), { recursive: true });
        const tmp = allowPath + ".tmp";
        writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom }, null, 2));
        renameSync(tmp, allowPath);
      }
      console.log(`Approved sender ${result.senderId} for bot ${name}. They can now use the bot.`);
      return;
    }
    console.error(`No pending request with code "${code}" found across any bot.`);
    process.exit(1);
  });

// --- group ---
const group = program.command("group").description("Manage group access");

group
  .command("list")
  .description("List all configured groups")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId, name } = resolveBotId(config, opts.bot);
    const bots = resolveBots(config);
    const botConfig = bots.find(b => b.botId === botId);

    // Config groups
    const configGroups = botConfig?.groups ?? {};

    // Runtime groups
    const groupsPath = join(dataDir, "credentials", botId, "telegram-groups.json");
    let runtimeGroups: Record<string, { enabled: boolean; allowFrom?: string[] }> = {};
    if (existsSync(groupsPath)) {
      try {
        runtimeGroups = JSON.parse(readFileSync(groupsPath, "utf-8")).groups ?? {};
      } catch {}
    }

    // Merge
    const allIds = new Set([...Object.keys(configGroups), ...Object.keys(runtimeGroups)]);
    if (allIds.size === 0) {
      console.log(`No groups configured for bot ${name}.`);
      console.log(`\nGroup policy: ${botConfig?.groupPolicy ?? "disabled"}`);
      return;
    }

    console.log(`Groups for bot ${name} (policy: ${botConfig?.groupPolicy ?? "disabled"}):\n`);
    console.log("Chat ID              Enabled  Source    AllowFrom");
    console.log("-------------------  -------  --------  ---------");
    for (const id of allIds) {
      const cg = configGroups[id];
      const rg = runtimeGroups[id];
      const source = cg && rg ? "both" : cg ? "config" : "runtime";
      const effective = rg ?? cg;
      const enabled = effective?.enabled ? "yes" : "no";
      const allowFrom = effective?.allowFrom?.join(", ") || "(all)";
      console.log(`${id.padEnd(19)}  ${enabled.padEnd(7)}  ${source.padEnd(8)}  ${allowFrom}`);
    }
  });

group
  .command("add")
  .description("Add a group to the allowlist")
  .argument("<chatId>", "Group chat ID (negative number)")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((chatId: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const groupsPath = join(dataDir, "credentials", botId, "telegram-groups.json");

    let groups: Record<string, { enabled: boolean; allowFrom?: string[] }> = {};
    if (existsSync(groupsPath)) {
      try {
        groups = JSON.parse(readFileSync(groupsPath, "utf-8")).groups ?? {};
      } catch {}
    }

    if (groups[chatId]?.enabled) {
      console.log(`Group ${chatId} is already enabled.`);
      return;
    }

    groups[chatId] = { enabled: true };
    mkdirSync(join(dataDir, "credentials", botId), { recursive: true });
    const tmp = groupsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, groups }, null, 2));
    renameSync(tmp, groupsPath);
    console.log(`Group ${chatId} added and enabled. No restart needed.`);
  });

group
  .command("remove")
  .description("Remove a group from the runtime allowlist")
  .argument("<chatId>", "Group chat ID")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((chatId: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const groupsPath = join(dataDir, "credentials", botId, "telegram-groups.json");

    if (!existsSync(groupsPath)) {
      console.log(`Group ${chatId} not found in runtime groups.`);
      return;
    }

    let groups: Record<string, { enabled: boolean; allowFrom?: string[] }> = {};
    try {
      groups = JSON.parse(readFileSync(groupsPath, "utf-8")).groups ?? {};
    } catch {}

    if (!(chatId in groups)) {
      console.log(`Group ${chatId} not found in runtime groups.`);

      // Check if it's in config
      const bots = resolveBots(config);
      const botConfig = bots.find(b => b.botId === botId);
      if (botConfig?.groups[chatId]) {
        console.log(`Note: This group is configured in config.yaml. Edit the file to remove it.`);
      }
      return;
    }

    delete groups[chatId];
    const tmp = groupsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, groups }, null, 2));
    renameSync(tmp, groupsPath);
    console.log(`Group ${chatId} removed. No restart needed.`);
  });

group
  .command("approve")
  .description("Approve a group pairing code")
  .argument("<code>", "Pairing code from the group")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((code: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const pairingPath = join(dataDir, "credentials", botId, "telegram-pairing.json");
    const groupsPath = join(dataDir, "credentials", botId, "telegram-groups.json");

    const pm = new PairingManager(pairingPath);
    const result = pm.approve(code);
    if (!result) {
      console.error(`No pending request with code "${code}".`);
      process.exit(1);
    }

    // Extract chat ID from "group:<chatId>" format
    const chatId = result.senderId.replace(/^group:/, "");

    let groups: Record<string, { enabled: boolean; allowFrom?: string[] }> = {};
    if (existsSync(groupsPath)) {
      try {
        groups = JSON.parse(readFileSync(groupsPath, "utf-8")).groups ?? {};
      } catch {}
    }

    groups[chatId] = { enabled: true };
    mkdirSync(join(dataDir, "credentials", botId), { recursive: true });
    const tmp = groupsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, groups }, null, 2));
    renameSync(tmp, groupsPath);
    console.log(`Group ${chatId} approved and enabled. No restart needed.`);
  });

group
  .command("disable")
  .description("Disable a group without removing it")
  .argument("<chatId>", "Group chat ID")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((chatId: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const groupsPath = join(dataDir, "credentials", botId, "telegram-groups.json");

    let groups: Record<string, { enabled: boolean; allowFrom?: string[] }> = {};
    if (existsSync(groupsPath)) {
      try {
        groups = JSON.parse(readFileSync(groupsPath, "utf-8")).groups ?? {};
      } catch {}
    }

    groups[chatId] = { ...(groups[chatId] ?? {}), enabled: false };
    mkdirSync(join(dataDir, "credentials", botId), { recursive: true });
    const tmp = groupsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, groups }, null, 2));
    renameSync(tmp, groupsPath);
    console.log(`Group ${chatId} disabled. No restart needed.`);
  });

// --- allow ---
const allow = program.command("allow").description("Manage allowlist");

allow
  .command("list")
  .description("List allowed users")
  .argument("[channel]", "Channel name", "telegram")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((channel: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const allowPath = join(dataDir, "credentials", botId, `${channel}-allowFrom.json`);
    if (!existsSync(allowPath)) {
      console.log(`No allowlist for ${channel}.`);
      return;
    }
    const data = JSON.parse(readFileSync(allowPath, "utf-8"));
    const list: string[] = data.allowFrom ?? [];
    if (list.length === 0) {
      console.log(`Allowlist for ${channel} is empty.`);
    } else {
      console.log(`Allowed users for ${channel}:`);
      list.forEach((id: string) => console.log(`  ${id}`));
    }
  });

allow
  .command("add")
  .description("Add user to allowlist")
  .argument("<channel>", "Channel name")
  .argument("<id>", "User ID")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((channel: string, id: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const allowPath = join(dataDir, "credentials", botId, `${channel}-allowFrom.json`);
    let allowFrom: string[] = [];
    if (existsSync(allowPath)) {
      try {
        allowFrom = JSON.parse(readFileSync(allowPath, "utf-8")).allowFrom ?? [];
      } catch {}
    }
    if (allowFrom.includes(id)) {
      console.log(`User ${id} is already in ${channel} allowlist.`);
      return;
    }
    allowFrom.push(id);
    mkdirSync(join(dataDir, "credentials", botId), { recursive: true });
    const tmp = allowPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom }, null, 2));
    renameSync(tmp, allowPath);
    console.log(`Added ${id} to ${channel} allowlist.`);
  });

allow
  .command("remove")
  .description("Remove user from allowlist")
  .argument("<channel>", "Channel name")
  .argument("<id>", "User ID")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((channel: string, id: string, opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const allowPath = join(dataDir, "credentials", botId, `${channel}-allowFrom.json`);
    if (!existsSync(allowPath)) {
      console.log(`No allowlist for ${channel}.`);
      return;
    }
    let allowFrom: string[] = [];
    try {
      allowFrom = JSON.parse(readFileSync(allowPath, "utf-8")).allowFrom ?? [];
    } catch {}
    const filtered = allowFrom.filter((x: string) => x !== id);
    if (filtered.length === allowFrom.length) {
      console.log(`User ${id} not found in ${channel} allowlist.`);
      return;
    }
    const tmp = allowPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom: filtered }, null, 2));
    renameSync(tmp, allowPath);
    console.log(`Removed ${id} from ${channel} allowlist.`);
  });

// --- bot ---
const bot = program.command("bot").description("Manage bots");

bot
  .command("list")
  .description("List all configured bots")
  .option("-c, --config <path>", "Path to config file")
  .action(async (opts: { config?: string }) => {
    const config = loadConfig(opts.config);
    const bots = resolveBots(config);
    const dataDir = getDataDir(opts.config);

    if (bots.length === 0) {
      console.log("No bots configured. Add one with: openclaude bot add <token>");
      return;
    }

    // Check if gateway is running
    const pid = getRunningPid(dataDir);

    console.log("Bots:\n");
    for (const b of bots) {
      const status = pid ? "running" : "stopped";
      // Try to get username from Telegram API
      let username = "";
      try {
        const res = await fetch(`https://api.telegram.org/bot${b.token}/getMe`);
        const data = await res.json() as { ok: boolean; result?: { username?: string } };
        if (data.ok && data.result?.username) username = `@${data.result.username}`;
      } catch {}
      const line = [
        `  ${b.name}`,
        `(${b.botId})`,
        username,
        status,
        `${b.dmPolicy}/${b.groupPolicy}`,
      ].filter(Boolean).join("  ");
      console.log(line);
    }
  });

bot
  .command("add")
  .description("Add a new bot")
  .argument("<token>", "Telegram bot token from BotFather")
  .option("-n, --name <name>", "Bot name (default: auto-detect from Telegram)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (token: string, opts: { name?: string; config?: string }) => {
    // Validate token format
    if (!token.includes(":")) {
      console.error("Invalid token format. Expected: <bot_id>:<secret>");
      process.exit(1);
    }

    const botId = token.split(":")[0];

    // Check for duplicate
    const config = loadConfig(opts.config);
    const existing = resolveBots(config);
    if (existing.find(b => b.botId === botId)) {
      console.error(`Bot ${botId} is already configured.`);
      process.exit(1);
    }

    // Get bot info from Telegram
    let name = opts.name;
    let username = "";
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { first_name?: string; username?: string }; description?: string };
      if (!data.ok) {
        console.error(`Invalid token: Telegram API rejected it.`);
        process.exit(1);
      }
      if (!name && data.result?.first_name) {
        name = data.result.first_name.toLowerCase().replace(/\s+/g, "-");
      }
      if (data.result?.username) {
        username = `@${data.result.username}`;
      }
    } catch (err) {
      console.error(`Failed to connect to Telegram API: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    if (!name) name = `bot-${botId}`;

    // Modify config.yaml using Document API to preserve formatting
    const configPath = opts.config ?? resolve(process.env.HOME ?? "~", ".openclaude", "config.yaml");
    const content = readFileSync(configPath, "utf-8");
    const doc = parseDocument(content);

    // Ensure bots array exists
    if (!doc.has("bots")) {
      doc.set("bots", []);
    }
    const botsNode = doc.get("bots") as import("yaml").YAMLSeq;
    botsNode.add(doc.createNode({
      name,
      token,
      auth: { dmPolicy: "pairing", groupPolicy: "pairing" },
    }));

    writeFileSync(configPath, doc.toString());

    console.log(`Added bot "${name}" (${botId}) ${username}`);
    console.log(`Config saved to ${configPath}`);

    // Trigger hot-reload if gateway is running
    const dataDir = getDataDir(opts.config);
    const pid = getRunningPid(dataDir);
    if (pid) {
      try {
        await fetch(`http://127.0.0.1:${config.gateway.port}/api/reload-config`, { method: "POST" });
        console.log("Gateway reloaded — new bot should be starting.");
      } catch {
        console.log("Gateway is running but reload failed. Restart with: openclaude gateway restart");
      }
    } else {
      console.log("Start the gateway with: openclaude gateway start");
    }
  });

bot
  .command("remove")
  .description("Remove a bot")
  .argument("<name>", "Bot name to remove")
  .option("-c, --config <path>", "Path to config file")
  .action(async (name: string, opts: { config?: string }) => {
    const configPath = opts.config ?? resolve(process.env.HOME ?? "~", ".openclaude", "config.yaml");
    const content = readFileSync(configPath, "utf-8");
    const doc = parseDocument(content);

    const botsNode = doc.get("bots") as import("yaml").YAMLSeq | undefined;
    if (!botsNode || botsNode.items.length === 0) {
      console.error("No bots configured.");
      process.exit(1);
    }

    // Find the bot by name
    let foundIdx = -1;
    for (let i = 0; i < botsNode.items.length; i++) {
      const item = botsNode.items[i] as import("yaml").YAMLMap;
      const itemName = item.get("name");
      if (itemName === name) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx === -1) {
      const config = loadConfig(opts.config);
      const bots = resolveBots(config);
      console.error(`Bot "${name}" not found. Available: ${bots.map(b => b.name).join(", ")}`);
      process.exit(1);
    }

    botsNode.items.splice(foundIdx, 1);
    writeFileSync(configPath, doc.toString());

    console.log(`Removed bot "${name}" from config.`);

    // Trigger hot-reload if gateway is running
    const config = loadConfig(opts.config);
    const dataDir = getDataDir(opts.config);
    const pid = getRunningPid(dataDir);
    if (pid) {
      try {
        await fetch(`http://127.0.0.1:${config.gateway.port}/api/reload-config`, { method: "POST" });
        console.log("Gateway reloaded.");
      } catch {
        console.log("Restart gateway to apply: openclaude gateway restart");
      }
    }
  });

// --- bot soul ---
const soul = bot.command("soul").description("Manage bot personality (SOUL.md)");

soul
  .command("show")
  .description("Show current SOUL.md")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId, name } = resolveBotId(config, opts.bot);
    const soulPath = join(dataDir, "agents", botId, "SOUL.md");
    if (!existsSync(soulPath)) {
      console.log(`No SOUL.md found for bot ${name} (${botId}).`);
      console.log(`Create one with: openclaude bot soul edit`);
      return;
    }
    console.log(`SOUL.md for bot ${name} (${soulPath}):\n`);
    console.log(readFileSync(soulPath, "utf-8"));
  });

soul
  .command("edit")
  .description("Edit SOUL.md in your default editor")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    const agentDir = join(dataDir, "agents", botId);
    mkdirSync(agentDir, { recursive: true });
    const soulPath = join(agentDir, "SOUL.md");

    if (!existsSync(soulPath)) {
      writeFileSync(soulPath, "# Soul\n\nDescribe your bot's personality here.\n");
    }

    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    const child = spawn(editor, [soulPath], { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`SOUL.md saved. Changes apply to new sessions.`);
      }
      process.exit(code ?? 0);
    });
  });

soul
  .command("reset")
  .description("Delete SOUL.md (reset to default behavior)")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId, name } = resolveBotId(config, opts.bot);
    const soulPath = join(dataDir, "agents", botId, "SOUL.md");
    if (!existsSync(soulPath)) {
      console.log("No SOUL.md to remove.");
      return;
    }
    unlinkSync(soulPath);
    console.log(`SOUL.md removed for bot ${name} (${botId}).`);
  });

soul
  .command("path")
  .description("Print the SOUL.md file path")
  .option("-c, --config <path>", "Path to config file")
  .option("--bot <name>", "Bot name")
  .action((opts: { config?: string; bot?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const { botId } = resolveBotId(config, opts.bot);
    console.log(join(dataDir, "agents", botId, "SOUL.md"));
  });

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

program.parse();
