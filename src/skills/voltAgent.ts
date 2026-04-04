/**
 * VoltAgent Skill Wrapper
 *
 * Spawns VoltAgent-style subagents for Hermes execution using Ollama.
 * Roles are hard-coded from awesome-codex-subagents .toml definitions.
 */

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface VoltAgentRole {
  name: string;
  description: string;
  model: string;
  sandboxMode: "none" | "container" | "wasm";
  instructions: string;
}

// ── Core Roles ──────────────────────────────────────────────────────────────

export const VOLT_AGENT_ROLES: Record<string, VoltAgentRole> = {
  "financial-analyst": {
    name: "financial-analyst",
    description: "Categorize and analyze financial transactions",
    model: process.env["HERMES_EXECUTOR_MODEL"] ?? "dolphin-llama3:8b",
    sandboxMode: "none",
    instructions:
      "You are a financial analyst agent. Categorize transactions by type (income, expense, transfer, investment). " +
      "Extract amounts, dates, counterparties, and categories. Output structured JSON with your analysis. " +
      "Flag anomalies such as duplicate charges, unusual amounts, or missing fields.",
  },
  "code-reviewer": {
    name: "code-reviewer",
    description: "Review TypeScript/Rust code for correctness",
    model: "dolphin-llama3:8b",
    sandboxMode: "none",
    instructions:
      "You are a code review agent specializing in TypeScript and Rust. " +
      "Analyze code for correctness, type safety, error handling, and potential bugs. " +
      "Provide actionable feedback with specific line references and suggested fixes.",
  },
  researcher: {
    name: "researcher",
    description: "Search and synthesize information",
    model: process.env["HERMES_EXECUTOR_MODEL"] ?? "dolphin-llama3:8b", // warm in VRAM; qwen3.5:27b cold (~60s)
    sandboxMode: "none",
    instructions:
      "You are a research agent. Given a topic or question, synthesize available information into a clear, " +
      "structured summary. Cite sources when possible. Identify knowledge gaps and suggest follow-up queries.",
  },
  planner: {
    name: "planner",
    description: "Decompose complex tasks into sub-tasks",
    model: process.env["HERMES_EXECUTOR_MODEL"] ?? "dolphin-llama3:8b", // warm in VRAM; qwen3.5:27b cold (~60s)
    sandboxMode: "none",
    instructions:
      "You are a planning agent. Decompose complex tasks into ordered sub-tasks with clear dependencies. " +
      "Estimate effort for each sub-task. Output a structured plan with step IDs, descriptions, and dependency edges.",
  },
  summarizer: {
    name: "summarizer",
    description: "Distill long results into concise summaries",
    model: "dolphin-llama3:8b",
    sandboxMode: "none",
    instructions:
      "You are a summarization agent. Distill long text, logs, or data into concise summaries. " +
      "Preserve key facts, numbers, and decisions. Output no more than 3-5 bullet points unless asked otherwise.",
  },
};

// ── Executor ────────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

export class VoltAgentExecutor {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? OLLAMA_BASE_URL;
  }

  async execute(
    role: VoltAgentRole,
    task: string,
    context?: string,
  ): Promise<string> {
    const messages = [
      { role: "system", content: role.instructions },
      ...(context
        ? [{ role: "user", content: `Context:\n${context}\n\nTask: ${task}` }]
        : [{ role: "user", content: task }]),
    ];

    const url = `${this.baseUrl}/api/chat`;
    console.log(`[VoltAgent:${role.name}] Calling Ollama model=${role.model}`);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000), // 60s per LLM call
      body: JSON.stringify({
        model: role.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `[VoltAgent:${role.name}] Ollama returned ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? "";
    console.log(
      `[VoltAgent:${role.name}] Response length=${content.length} chars`,
    );
    return content;
  }

  getRole(name: string): VoltAgentRole | undefined {
    return VOLT_AGENT_ROLES[name];
  }
}
