/**
 * Telegram Input Handler — Primary Hermes task channel
 *
 * Receives tasks from Telegram (via OpenClaw plugin or direct bot),
 * normalizes them into HermesTask objects, and feeds into HermesLoop.run().
 */

import { HermesLoop, HermesTask } from "../core/loop.js";
import { randomUUID } from "crypto";

export interface TelegramMessage {
  messageId: string;
  chatId: number;
  userId: number;
  text: string;
  timestamp: Date;
}

export class TelegramInterface {
  private loop: HermesLoop;

  constructor(loop: HermesLoop) {
    this.loop = loop;
  }

  async handleMessage(msg: TelegramMessage): Promise<void> {
    const task: HermesTask = {
      id: randomUUID(),
      input: msg.text,
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
      const trajectory = await this.loop.run(task);
      console.log(`[TelegramInterface] Task complete — score=${trajectory.rewardSignal?.score.toFixed(3)}`);
      // TODO: Send result back to Telegram chat via bot API
    } catch (err) {
      console.error(`[TelegramInterface] Task error — id=${task.id}`, err);
      // TODO: Send error message to Telegram
    }
  }
}
