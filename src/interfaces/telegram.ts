/**
 * Telegram Input Handler — Primary Hermes task channel
 *
 * Receives tasks from Telegram (via OpenClaw plugin or direct bot),
 * normalizes them into HermesTask objects, and feeds into HermesLoop.run().
 *
 * Commands:
 *   /hermes <task>       — Run a task through the 8-step loop
 *   /hermes-status       — Show SONA stats + top patterns (no task execution)
 */

import { HermesLoop, HermesTask } from "../core/loop.js";
import { SonaDaemon } from "../brain/sona.js";
import { SkillEvolution } from "../skills/evolution.js";
import { HermesMemory } from "../brain/ruvector.js";
import { randomUUID } from "crypto";

const BOT_TOKEN = "REDACTED_OLD_TOKEN";
const DANIEL_CHAT_ID = 938702109;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_INTERVAL_MS = 2000;

export interface TelegramMessage {
  messageId: string;
  chatId: number;
  userId: number;
  text: string;
  timestamp: Date;
}

export class TelegramInterface {
  private loop: HermesLoop;
  private sona: SonaDaemon;
  private skillEvolution: SkillEvolution;
  private offset = 0;
  private polling = false;

  constructor(loop: HermesLoop, sona?: SonaDaemon) {
    this.loop = loop;
    this.sona = sona ?? new SonaDaemon();
    const memory = new HermesMemory();
    this.skillEvolution = new SkillEvolution(memory);
  }

  /**
   * Start long-polling getUpdates every 2 seconds.
   * Only responds to Daniel's chatId or messages starting with /hermes.
   */
  async startPolling(): Promise<void> {
    this.polling = true;
    console.log(`[Telegram] Polling started — chatId filter=${DANIEL_CHAT_ID}`);

    while (this.polling) {
      try {
        const res = await fetch(
          `${API_BASE}/getUpdates?offset=${this.offset}&limit=10&timeout=2`
        );

        if (!res.ok) {
          console.error(`[Telegram] getUpdates HTTP ${res.status}`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const data = (await res.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              message_id: number;
              chat: { id: number };
              from?: { id: number };
              text?: string;
              date: number;
            };
          }>;
        };

        if (!data.ok || !data.result.length) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          const msg = update.message;
          if (!msg?.text) continue;

          const chatId = msg.chat.id;
          const text = msg.text;

          // Only respond to Daniel's chatId or /hermes commands
          if (chatId !== DANIEL_CHAT_ID && !text.startsWith("/hermes")) {
            continue;
          }

          const telegramMsg: TelegramMessage = {
            messageId: String(msg.message_id),
            chatId,
            userId: msg.from?.id ?? chatId,
            text,
            timestamp: new Date(msg.date * 1000),
          };

          // Handle message without blocking the poll loop
          this.handleMessage(telegramMsg).catch((err) => {
            console.error(`[Telegram] Unhandled error in handleMessage:`, err);
          });
        }
      } catch (err) {
        console.error(`[Telegram] Poll error:`, err);
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  stopPolling(): void {
    this.polling = false;
    console.log(`[Telegram] Polling stopped`);
  }

  async handleMessage(msg: TelegramMessage): Promise<void> {
    const text = msg.text.trim();

    // Handle /hermes-status command
    if (text === "/hermes-status" || text === "/hermes_status") {
      await this.handleStatusCommand(msg.chatId);
      return;
    }

    // Strip /hermes prefix if present
    let taskInput = text;
    if (text.startsWith("/hermes ")) {
      taskInput = text.slice(8).trim();
    } else if (text === "/hermes") {
      await this.sendMessage(msg.chatId, "Usage: /hermes <task>\nExample: /hermes Categorize this expense: $45 coffee shop");
      return;
    }

    const task: HermesTask = {
      id: randomUUID(),
      input: taskInput,
      context: {
        chatId: msg.chatId,
        userId: msg.userId,
        messageId: msg.messageId,
      },
      source: "telegram",
      recursionDepth: 0,
      submittedAt: msg.timestamp,
    };

    console.log(`[TelegramInterface] Task received — id=${task.id} input="${task.input.slice(0, 60)}..."`);

    try {
      const startTime = Date.now();
      const trajectory = await this.loop.run(task);
      const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
      const score = trajectory.rewardSignal?.score.toFixed(2) ?? "N/A";
      const cost = trajectory.totalCostUsd.toFixed(2);
      const pattern = trajectory.rewardSignal?.taskPattern ?? "unknown";

      // Step completion status
      const totalSteps = trajectory.executionResults.length;
      const passedSteps = trajectory.executionResults.filter((r) => r.success).length;
      const failedSteps = totalSteps - passedSteps;

      const stepStatus = totalSteps > 0
        ? `${passedSteps}/${totalSteps} passed` + (failedSteps > 0 ? ` (${failedSteps} failed)` : "")
        : "no steps";

      // Evaluate for patterns
      const evaluation = await this.skillEvolution.evaluate(trajectory);
      const topPatterns = this.skillEvolution.getTopPatterns(2, 1);

      const lines = [
        "🧠 Hermes complete",
        `• Steps: ${stepStatus}`,
        `• Reward: ${score}`,
        `• Duration: ${durationS}s`,
        `• Cost: $${cost}`,
        `• Pattern: ${pattern}`,
      ];

      if (topPatterns.length > 0) {
        lines.push("", "📊 Top patterns:");
        for (const p of topPatterns) {
          lines.push(`  • "${p.pattern.slice(0, 40)}" (${p.totalSamples} samples, ${(p.successRate * 100).toFixed(0)}%)`);
        }
      }

      await this.sendMessage(msg.chatId, lines.join("\n"));
      console.log(`[TelegramInterface] Task complete — score=${score}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramInterface] Task error — id=${task.id}`, err);
      await this.sendMessage(msg.chatId, `⚠️ Hermes error: ${errorMsg}`);
    }
  }

  private async handleStatusCommand(chatId: number): Promise<void> {
    try {
      const stats = await this.sona.getStats();
      const topPatterns = this.skillEvolution.getTopPatterns(3, 1);

      const lines = [
        "📡 Hermes Status",
        "",
        "SONA:",
      ];

      if (stats.local) {
        const local = stats.local as Record<string, unknown>;
        lines.push(`  • Buffer: ${local.trajectoryBufferSize ?? 0} trajectories`);
        lines.push(`  • Queue: ${local.trajectoryQueueSize ?? 0} pending`);
        lines.push(`  • EWC steps: ${local.ewcStepsPending ?? 0}`);
        lines.push(`  • Routing v${local.routingTableVersion ?? 0} (${local.routingTableEntries ?? 0} entries)`);
      } else {
        for (const [k, v] of Object.entries(stats)) {
          if (k !== "error") lines.push(`  • ${k}: ${v}`);
        }
      }

      if (topPatterns.length > 0) {
        lines.push("", "Top patterns:");
        for (const p of topPatterns) {
          lines.push(`  • "${p.pattern.slice(0, 40)}" — ${p.totalSamples} samples, ${(p.successRate * 100).toFixed(0)}%`);
        }
      } else {
        lines.push("", "No patterns tracked yet.");
      }

      await this.sendMessage(chatId, lines.join("\n"));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `⚠️ Status error: ${errorMsg}`);
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });

      if (!res.ok) {
        console.error(`[Telegram] sendMessage HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[Telegram] sendMessage failed:`, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
