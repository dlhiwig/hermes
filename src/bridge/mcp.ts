/**
 * MCP + A2A Bridge — Inter-Agent Communication
 *
 * Connects Hermes to Alpha/Bravo/Charlie agents via HTTP relay.
 * Provides sendToAgent() for outbound messages and listenForMessages() for inbound.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface MCPAgentDescriptor {
  agentId: string;
  name: string;         // Alpha | Bravo | Charlie | etc.
  endpoint: string;
  capabilities: string[];
  protocol: "mcp" | "a2a" | "http";
}

export interface MCPMessage {
  from: string;
  to: string;
  type: "task" | "result" | "event" | "heartbeat";
  payload: unknown;
  traceId: string;
  timestamp: Date;
}

export type AgentId = "alpha" | "bravo" | "charlie";

export class MCPBridge {
  private agents: Map<string, MCPAgentDescriptor>;
  private server: Server | null;
  private messageHandler: ((message: MCPMessage) => void) | null;

  constructor() {
    this.agents = new Map();
    this.server = null;
    this.messageHandler = null;
    this.registerKnownAgents();
  }

  private registerKnownAgents(): void {
    const known: MCPAgentDescriptor[] = [
      { agentId: "alpha", name: "Alpha", endpoint: "http://localhost:18790", capabilities: ["coding", "research"], protocol: "a2a" },
      { agentId: "bravo", name: "Bravo", endpoint: "http://localhost:18792", capabilities: ["analysis", "review"], protocol: "a2a" },
      { agentId: "charlie", name: "Charlie", endpoint: "http://localhost:18793", capabilities: ["memory", "research"], protocol: "a2a" },
    ];
    for (const agent of known) {
      this.agents.set(agent.agentId, agent);
      console.log(`[MCPBridge] Registered agent: ${agent.name} @ ${agent.endpoint}`);
    }
  }

  /**
   * Send a message to a specific agent via HTTP POST.
   * Returns the agent's text response.
   */
  async sendToAgent(agentId: AgentId, message: string): Promise<string> {
    const target = this.agents.get(agentId);
    if (!target) {
      throw new Error(`[MCPBridge] Unknown agent: ${agentId}`);
    }

    const mcpMessage: MCPMessage = {
      from: "hermes",
      to: agentId,
      type: "task",
      payload: { text: message },
      traceId: randomUUID(),
      timestamp: new Date(),
    };

    console.log(`[MCPBridge] Sending to ${target.name} @ ${target.endpoint} — traceId=${mcpMessage.traceId}`);

    const resp = await fetch(`${target.endpoint}/a2a/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpMessage),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`[MCPBridge] ${target.name} returned ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as { response?: string; result?: string };
    return data.response ?? data.result ?? JSON.stringify(data);
  }

  /**
   * Send a raw MCPMessage to the target agent.
   */
  async send(message: MCPMessage): Promise<void> {
    const target = this.agents.get(message.to);
    if (!target) {
      console.warn(`[MCPBridge] Unknown target agent: ${message.to}`);
      return;
    }

    await fetch(`${target.endpoint}/a2a/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30_000),
    });
  }

  async broadcast(from: string, type: MCPMessage["type"], payload: unknown): Promise<void> {
    for (const agentId of this.agents.keys()) {
      if (agentId !== from) {
        await this.send({ from, to: agentId, type, payload, traceId: randomUUID(), timestamp: new Date() });
      }
    }
  }

  /**
   * Register a callback for inbound A2A messages.
   */
  onMessage(handler: (message: MCPMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Start a local HTTP server to receive inbound A2A messages from other agents.
   */
  listenForMessages(port: number): void {
    if (this.server) {
      console.warn(`[MCPBridge] Already listening — ignoring duplicate call`);
      return;
    }

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agent: "hermes" }));
        return;
      }

      // A2A message endpoint
      if (req.method === "POST" && req.url === "/a2a/message") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const message = JSON.parse(body) as MCPMessage;
            console.log(`[MCPBridge] Received from ${message.from} — type=${message.type} traceId=${message.traceId}`);

            if (this.messageHandler) {
              this.messageHandler(message);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ received: true, traceId: message.traceId }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    this.server.listen(port, "127.0.0.1", () => {
      console.log(`[MCPBridge] Listening for A2A messages on http://127.0.0.1:${port}`);
    });
  }

  /**
   * Stop the A2A listener.
   */
  async stopListening(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        if (err) reject(err); else resolve();
      });
    });
  }

  getAgents(): MCPAgentDescriptor[] {
    return Array.from(this.agents.values());
  }
}
