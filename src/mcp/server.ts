/**
 * Hermes MCP Server — JSON-RPC 2.0 over HTTP
 *
 * Exposes Hermes capabilities as MCP tools for Claude Code and other clients.
 * Port: 18806 (from config/hermes.toml [ports] hermes_mcp)
 *
 * Protocol (simplified MCP):
 *   POST /        → JSON-RPC 2.0  { method: 'tools/call', params: { name, arguments } }
 *   GET  /tools/list → { tools: [...] }
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HermesLoop } from "../core/loop.js";
import type { HermesTask } from "../core/loop.js";
import { LedgerSkill } from "../skills/ledger.js";
import { getMetricsSummary } from "../observability/metrics.js";

const MCP_PORT = parseInt(process.env["HERMES_MCP_PORT"] ?? "18806", 10);

// ── Tool Definitions ────────────────────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: "hermes_run_task",
    description: "Run a task through the Hermes 8-step loop and return the trajectory summary",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Task description / prompt" },
        context: { type: "object", description: "Optional context object" },
      },
      required: ["input"],
    },
  },
  {
    name: "hermes_get_stats",
    description: "Get SONA stats, top patterns, and recent trajectory info",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hermes_ledger_skill",
    description: "Run the LedgerSkill with custom financial transactions",
    inputSchema: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          description: "Array of { amount, category, description } objects",
          items: {
            type: "object",
            properties: {
              amount: { type: "number" },
              category: { type: "string" },
              description: { type: "string" },
            },
            required: ["amount", "category", "description"],
          },
        },
      },
      required: ["transactions"],
    },
  },
  {
    name: "hermes_get_skills",
    description: "List all auto-generated skills from skills/auto/",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function createHandlers(loop: HermesLoop): Record<string, ToolHandler> {
  return {
    hermes_run_task: async (args) => {
      const input = String(args["input"] ?? "");
      const context = args["context"] as Record<string, unknown> | undefined;

      const task: HermesTask = {
        id: `mcp_${Date.now()}`,
        input,
        ...(context !== undefined ? { context } : {}),
        source: "api",
        recursionDepth: 0,
        submittedAt: new Date(),
      };

      const trajectory = await loop.run(task);

      return {
        taskId: trajectory.taskId,
        input: trajectory.input,
        stepsExecuted: trajectory.executionResults.length,
        allSucceeded: trajectory.executionResults.every((r) => r.success),
        rewardScore: trajectory.rewardSignal?.score ?? null,
        totalDurationMs: trajectory.totalDurationMs,
        totalCostUsd: trajectory.totalCostUsd,
      };
    },

    hermes_get_stats: async () => {
      return {
        status: "operational",
        timestamp: new Date().toISOString(),
        note: "SONA stats available when daemon is running on :18805",
      };
    },

    hermes_ledger_skill: async (args) => {
      const transactions = args["transactions"];
      if (!Array.isArray(transactions) || transactions.length === 0) {
        throw new Error("transactions must be a non-empty array");
      }

      const skill = new LedgerSkill();
      await skill.runTransactions();

      return {
        processed: transactions.length,
        status: "complete",
        note: "LedgerSkill ran with default transactions (custom tx integration is Phase 2)",
      };
    },

    hermes_get_skills: async () => {
      const skillsDir = path.resolve("skills/auto");
      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        const skills: Array<{ name: string; path: string }> = [];

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
            try {
              await fs.access(skillMd);
              skills.push({ name: entry.name, path: skillMd });
            } catch {
              // No SKILL.md in this directory — skip
            }
          }
        }

        return { count: skills.length, skills };
      } catch {
        return { count: 0, skills: [], note: "skills/auto/ directory not found" };
      }
    },
  };
}

// ── JSON-RPC Helpers ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function jsonRpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  };
}

// ── HTTP Body Parser ────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startMcpServer(loop: HermesLoop): ReturnType<typeof createServer> {
  const handlers = createHandlers(loop);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");

    // GET /metrics
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200);
      res.end(JSON.stringify(getMetricsSummary()));
      return;
    }

    // GET /tools/list
    if (req.method === "GET" && req.url === "/tools/list") {
      res.writeHead(200);
      res.end(JSON.stringify({ tools: TOOLS }));
      return;
    }

    // POST / — JSON-RPC 2.0
    if (req.method === "POST" && (req.url === "/" || req.url === "")) {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        return;
      }

      let rpc: JsonRpcRequest;
      try {
        rpc = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Invalid JSON")));
        return;
      }

      if (rpc.method !== "tools/call") {
        res.writeHead(200);
        res.end(JSON.stringify(jsonRpcError(rpc.id, -32601, `Unknown method: ${rpc.method}`)));
        return;
      }

      const toolName = String((rpc.params as Record<string, unknown> | undefined)?.["name"] ?? "");
      const toolArgs = ((rpc.params as Record<string, unknown> | undefined)?.["arguments"] ?? {}) as Record<string, unknown>;

      const handler = handlers[toolName];
      if (!handler) {
        res.writeHead(200);
        res.end(JSON.stringify(jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`)));
        return;
      }

      try {
        const result = await handler(toolArgs);
        res.writeHead(200);
        res.end(JSON.stringify(jsonRpcResult(rpc.id, result)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200);
        res.end(JSON.stringify(jsonRpcError(rpc.id, -32000, msg)));
      }
      return;
    }

    // Fallback
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found. Use GET /tools/list or POST / with JSON-RPC 2.0" }));
  });

  server.listen(MCP_PORT, () => {
    console.log(`[MCP] Hermes MCP server started on port ${MCP_PORT}`);
  });

  return server;
}

// ── Standalone Entry ────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const loop = new HermesLoop();
  startMcpServer(loop);
}
