import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Logger } from "pino";
import type { TelegramAdapter } from "../channels/telegram/adapter.js";

export interface ApiServerConfig {
  port: number;
  telegram: TelegramAdapter;
  dataDir: string;
  log: Logger;
}

export class ApiServer {
  private server: Server;
  private config: ApiServerConfig;
  private log: Logger;

  constructor(config: ApiServerConfig) {
    this.config = config;
    this.log = config.log.child({ module: "api" });
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, "127.0.0.1", () => {
        this.log.info({ port: this.config.port }, "API server listening");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.config.port}`);

    try {
      if (req.method === "POST" && url.pathname === "/api/send-file") {
        await this.handleSendFile(req, res, url);
      } else if (req.method === "POST" && url.pathname === "/api/send-message") {
        await this.handleSendMessage(req, res, url);
      } else if (url.pathname === "/api/soul") {
        await this.handleSoul(req, res, url);
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (err) {
      this.log.error({ error: err instanceof Error ? err.message : String(err) }, "API error");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  /**
   * POST /api/send-file?chat_id=xxx&file_path=/abs/path/to/file
   * OR multipart form with file upload (future)
   */
  private async handleSendFile(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const chatId = url.searchParams.get("chat_id");
    const filePath = url.searchParams.get("file_path");

    if (!chatId || !filePath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing chat_id or file_path" }));
      return;
    }

    const fileName = basename(filePath);

    // Determine if it's a photo or document based on extension
    const ext = fileName.toLowerCase().split(".").pop() ?? "";
    const photoExts = ["jpg", "jpeg", "png", "gif", "webp"];

    if (photoExts.includes(ext)) {
      await this.config.telegram.sendPhoto(chatId, filePath);
    } else {
      await this.config.telegram.sendDocument(chatId, filePath);
    }

    this.log.info({ chatId, filePath }, "Sent file to Telegram");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, file: fileName }));
  }

  /**
   * POST /api/send-message?chat_id=xxx&text=hello
   */
  private async handleSendMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const chatId = url.searchParams.get("chat_id");
    let text = url.searchParams.get("text");

    // Also accept JSON body
    if (!text) {
      const body = await readBody(req);
      try {
        const json = JSON.parse(body);
        text = json.text;
      } catch {}
    }

    if (!chatId || !text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing chat_id or text" }));
      return;
    }

    await this.config.telegram.send({ chatId, text });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * GET    /api/soul?bot_id=xxx  — read SOUL.md
   * PUT    /api/soul?bot_id=xxx  — write SOUL.md (JSON body: {content: "..."})
   * DELETE /api/soul?bot_id=xxx  — delete SOUL.md
   */
  private async handleSoul(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const botId = url.searchParams.get("bot_id");
    if (!botId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing bot_id" }));
      return;
    }

    const agentsDir = join(this.config.dataDir, "agents");
    const soulPath = join(agentsDir, botId, "SOUL.md");

    if (req.method === "GET") {
      let content: string | null = null;
      if (existsSync(soulPath)) {
        content = readFileSync(soulPath, "utf-8");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, content }));
      return;
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      let content: string;
      try {
        content = JSON.parse(body).content;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body, expected {content: string}" }));
        return;
      }
      mkdirSync(join(agentsDir, botId), { recursive: true });
      writeFileSync(soulPath, content, "utf-8");
      this.log.info({ botId, soulPath }, "SOUL.md updated");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "DELETE") {
      if (existsSync(soulPath)) {
        unlinkSync(soulPath);
        this.log.info({ botId }, "SOUL.md deleted");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
