/**
 * MCP + A2A Bridge — Inter-Agent Communication
 *
 * Connects Hermes to Alpha/Bravo/Charlie agents via MCP protocol.
 * Also stubs A2A (Agent-to-Agent) protocol for VoltAgent inter-agent comms.
 */

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

export class MCPBridge {
  private agents: Map<string, MCPAgentDescriptor>;

  constructor() {
    this.agents = new Map();
    this.registerKnownAgents();
  }

  private registerKnownAgents(): void {
    // TODO: Load from hermes.toml config
    const known: MCPAgentDescriptor[] = [
      { agentId: "alpha", name: "Alpha", endpoint: "http://localhost:18791", capabilities: ["coding", "research"], protocol: "mcp" },
      { agentId: "bravo", name: "Bravo", endpoint: "http://localhost:18792", capabilities: ["analysis", "review"], protocol: "mcp" },
      { agentId: "charlie", name: "Charlie", endpoint: "http://localhost:18793", capabilities: ["memory", "research"], protocol: "mcp" },
    ];
    for (const agent of known) {
      this.agents.set(agent.agentId, agent);
      console.log(`[MCPBridge] Registered agent: ${agent.name} @ ${agent.endpoint}`);
    }
  }

  async send(message: MCPMessage): Promise<void> {
    const target = this.agents.get(message.to);
    if (!target) {
      console.warn(`[MCPBridge] Unknown target agent: ${message.to}`);
      return;
    }
    // TODO: POST to target.endpoint via MCP protocol
    // await fetch(`${target.endpoint}/mcp/message`, {
    //   method: "POST",
    //   body: JSON.stringify(message),
    // });
    console.log(`[MCPBridge] STUB send — ${message.from} → ${message.to} type=${message.type}`);
  }

  async broadcast(from: string, type: MCPMessage["type"], payload: unknown): Promise<void> {
    for (const agentId of this.agents.keys()) {
      if (agentId !== from) {
        await this.send({ from, to: agentId, type, payload, traceId: Date.now().toString(), timestamp: new Date() });
      }
    }
  }

  getAgents(): MCPAgentDescriptor[] {
    return Array.from(this.agents.values());
  }
}
