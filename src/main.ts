/**
 * Hermes — Main Entry Point
 *
 * Starts:
 *  1. HermesLoop (8-step recursive self-learning orchestrator)
 *  2. TelegramInterface (long-polling task ingestion)
 *  3. SonaDaemon (GNN background optimizer on port 18805)
 *
 * Registers SIGINT/SIGTERM for graceful shutdown.
 */

import { HermesLoop } from "./core/loop.js";
import { TelegramInterface } from "./interfaces/telegram.js";
import { SonaDaemon } from "./brain/sona.js";
import { startMcpServer } from "./mcp/server.js";

// ── Kill Switches (mirrored from loop.ts for banner display) ─────────────────
const KILL_SWITCHES = {
  MAX_RECURSION_DEPTH: 5,
  MAX_CONCURRENT_AGENTS: 10,
  SPEND_GATE_USD: 50,
  MAX_LOOP_ITERATIONS_PER_HOUR: 1000,
} as const;

const VERSION = "0.1.0";
const SONA_PORT = parseInt(process.env["SONA_PORT"] ?? "18805", 10);
const MCP_PORT = parseInt(process.env["HERMES_MCP_PORT"] ?? "18806", 10);

// ── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       ║
║   ██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝       ║
║   ███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗       ║
║   ██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║       ║
║   ██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║       ║
║   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝       ║
║                                                              ║
║   Recursive Self-Learning Orchestrator           v${VERSION}    ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  Kill Switches:                                              ║
║    MAX_RECURSION_DEPTH        = ${String(KILL_SWITCHES.MAX_RECURSION_DEPTH).padEnd(5)}                       ║
║    MAX_CONCURRENT_AGENTS      = ${String(KILL_SWITCHES.MAX_CONCURRENT_AGENTS).padEnd(5)}                       ║
║    SPEND_GATE_USD             = $${String(KILL_SWITCHES.SPEND_GATE_USD).padEnd(4)}                       ║
║    MAX_LOOP_ITERATIONS/HOUR   = ${String(KILL_SWITCHES.MAX_LOOP_ITERATIONS_PER_HOUR).padEnd(5)}                       ║
║  SONA Port:                     ${String(SONA_PORT).padEnd(5)}                       ║
║  MCP  Port:                     ${String(MCP_PORT).padEnd(5)}                       ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  // 1. Initialize core loop
  const loop = new HermesLoop();
  console.log("[Main] HermesLoop initialized");

  // 2. Start SONA background optimizer
  const sona = new SonaDaemon();
  sona.start();
  console.log(`[Main] SONA daemon started on :${SONA_PORT}`);

  // 3. Start MCP server
  const mcpServer = startMcpServer(loop);
  console.log(`[Main] MCP server started on :${MCP_PORT}`);

  // 4. Start Telegram polling
  const telegram = new TelegramInterface(loop);
  const telegramPromise = telegram.startPolling();
  console.log("[Main] Telegram polling started");

  console.log("[Main] Hermes is live. Waiting for tasks...\n");

  // ── Graceful Shutdown ──────────────────────────────────────────────────

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[Main] Received ${signal} — shutting down gracefully...`);

    telegram.stopPolling();
    console.log("[Main] Telegram polling stopped");

    mcpServer.close();
    console.log("[Main] MCP server stopped");

    sona.stop();
    console.log("[Main] SONA daemon stopped");

    console.log("[Main] Hermes shutdown complete. Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep alive — Telegram polling loop runs until stopped
  await telegramPromise;
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
