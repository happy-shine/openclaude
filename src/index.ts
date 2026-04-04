#!/usr/bin/env node

import { Command } from "commander";
import pino from "pino";
import { loadConfig } from "./config/loader.js";
import { Gateway } from "./gateway.js";
import { PairingManager } from "./auth/pairing.js";
import { spawn } from "node:child_process";
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

// --- gateway ---
const gateway = program.command("gateway").description("Manage the gateway daemon");

gateway
  .command("start")
  .description("Start the gateway")
  .option("-c, --config <path>", "Path to config file")
  .option("-v, --verbose", "Enable debug logging")
  .option("-f, --foreground", "Run in foreground (default: background daemon)")
  .action(async (opts: { config?: string; verbose?: boolean; foreground?: boolean }) => {
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
    const config = loadConfig(opts.config);
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

    const gateway = new Gateway(config, log);

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
  .action(() => {
    const dataDir = getDataDir();
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
        console.log(`Gateway is running (PID ${lockData.pid}, started ${lockData.createdAt})`);
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
  .action(() => {
    const dataDir = getDataDir();
    const pairingPath = join(dataDir, "credentials", "telegram-pairing.json");
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
  .option("--notify", "Send approval notification to user")
  .action((code: string) => {
    const dataDir = getDataDir();
    const pairingPath = join(dataDir, "credentials", "telegram-pairing.json");
    const allowPath = join(dataDir, "credentials", "telegram-allowFrom.json");
    const pm = new PairingManager(pairingPath);
    const result = pm.approve(code);
    if (!result) {
      console.error(`No pending request with code "${code}".`);
      process.exit(1);
    }
    let allowFrom: string[] = [];
    if (existsSync(allowPath)) {
      try {
        allowFrom = JSON.parse(readFileSync(allowPath, "utf-8")).allowFrom ?? [];
      } catch {}
    }
    if (!allowFrom.includes(result.senderId)) {
      allowFrom.push(result.senderId);
      mkdirSync(join(dataDir, "credentials"), { recursive: true });
      const tmp = allowPath + ".tmp";
      writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom }, null, 2));
      renameSync(tmp, allowPath);
    }
    console.log(`Approved sender ${result.senderId}. They can now use the bot.`);
  });

// --- allow ---
const allow = program.command("allow").description("Manage allowlist");

allow
  .command("list")
  .description("List allowed users")
  .argument("[channel]", "Channel name", "telegram")
  .action((channel: string) => {
    const dataDir = getDataDir();
    const allowPath = join(dataDir, "credentials", `${channel}-allowFrom.json`);
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
  .action((channel: string, id: string) => {
    const dataDir = getDataDir();
    const allowPath = join(dataDir, "credentials", `${channel}-allowFrom.json`);
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
    mkdirSync(join(dataDir, "credentials"), { recursive: true });
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
  .action((channel: string, id: string) => {
    const dataDir = getDataDir();
    const allowPath = join(dataDir, "credentials", `${channel}-allowFrom.json`);
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

// --- agent ---
const agent = program.command("agent").description("Manage agent personality (SOUL.md)");

agent
  .command("show")
  .description("Show current SOUL.md for the bot")
  .option("-c, --config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const botId = config.channels.telegram?.botToken?.split(":")[0] ?? "default";
    const soulPath = join(dataDir, "agents", botId, "SOUL.md");
    if (!existsSync(soulPath)) {
      console.log(`No SOUL.md found for bot ${botId}.`);
      console.log(`Create one with: openclaude agent edit`);
      return;
    }
    console.log(`SOUL.md for bot ${botId} (${soulPath}):\n`);
    console.log(readFileSync(soulPath, "utf-8"));
  });

agent
  .command("edit")
  .description("Edit SOUL.md in your default editor")
  .option("-c, --config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const botId = config.channels.telegram?.botToken?.split(":")[0] ?? "default";
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
        console.log(`SOUL.md saved. Restart the gateway to apply changes.`);
      }
      process.exit(code ?? 0);
    });
  });

agent
  .command("reset")
  .description("Delete SOUL.md (reset to default behavior)")
  .option("-c, --config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const botId = config.channels.telegram?.botToken?.split(":")[0] ?? "default";
    const soulPath = join(dataDir, "agents", botId, "SOUL.md");
    if (!existsSync(soulPath)) {
      console.log("No SOUL.md to remove.");
      return;
    }
    unlinkSync(soulPath);
    console.log(`SOUL.md removed for bot ${botId}. Restart the gateway to apply.`);
  });

agent
  .command("path")
  .description("Print the SOUL.md file path")
  .option("-c, --config <path>", "Path to config file")
  .action((opts: { config?: string }) => {
    const dataDir = getDataDir(opts.config);
    const config = loadConfig(opts.config);
    const botId = config.channels.telegram?.botToken?.split(":")[0] ?? "default";
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
