/**
 * @file cli-bridge/discord-sender.ts
 * @description CLI Bridge 的 Discord 訊息發送抽象層
 *
 * 兩種模式：
 * 1. IndependentBotSender — 有 botToken → 獨立 Discord Client（可自行監聽 messageCreate）
 * 2. MainBotSender — fallback → 用主 bot 的 channel 直接發送
 */

import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { log } from "../logger.js";

// ── 介面 ──────────────────────────────────────────────────────────────────────

/** 訊息回呼：獨立 bot 收到訊息時觸發 */
export type OnMessageCallback = (message: Message) => void;

export interface BridgeSender {
  /** 模式標識 */
  readonly mode: "independent-bot" | "main-bot";

  /** 初始化（login 等） */
  init(channelId: string): Promise<void>;

  /** 回覆原始訊息（第一則） */
  reply(originalMessage: Message, content: string): Promise<Message>;

  /** 後續訊息 */
  send(content: string): Promise<Message>;

  /** 編輯已發送的訊息 */
  edit(message: Message, content: string): Promise<void>;

  /** 帶 components 的訊息（control_request / timeout 按鈕） */
  sendComponents(options: MessageCreateOptions): Promise<Message>;

  /** 編輯帶 components 的訊息 */
  editComponents(message: Message, options: MessageEditOptions): Promise<void>;

  /** 送 typing indicator */
  sendTyping(): void;

  /** 註冊 messageCreate 監聽（僅 IndependentBot 有效） */
  onMessage(callback: OnMessageCallback): void;

  /** 取得 bot user ID（用於 mention 判斷） */
  getBotUserId(): string | null;

  /** 銷毀（logout / 清理） */
  destroy(): Promise<void>;
}

// ── IndependentBotSender ──────────────────────────────────────────────────────

export class IndependentBotSender implements BridgeSender {
  readonly mode = "independent-bot" as const;
  private client: Client;
  private channel: TextChannel | null = null;
  private messageCallbacks: OnMessageCallback[] = [];

  constructor(private readonly botToken: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async init(channelId: string): Promise<void> {
    await this.client.login(this.botToken);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once("ready", () => resolve());
    });
    const ch = await this.client.channels.fetch(channelId);
    if (!ch?.isTextBased() || ch.isDMBased()) {
      throw new Error(`[bridge-sender] channel ${channelId} 不是 guild text channel`);
    }
    this.channel = ch as TextChannel;

    // 設定上線狀態
    this.client.user?.setPresence({ status: "online" });

    // 掛 messageCreate — 獨立 bot 自己監聽訊息
    this.client.on("messageCreate", (msg) => {
      // 忽略自己的訊息
      if (msg.author.id === this.client.user?.id) return;
      for (const cb of this.messageCallbacks) {
        try { cb(msg); } catch (err) {
          log.error(`[bridge-sender] onMessage callback error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    log.info(`[bridge-sender] independent bot ready: ${this.client.user?.tag} → #${this.channel.name}`);
  }

  async reply(originalMessage: Message, content: string): Promise<Message> {
    return this.channel!.send(content);
  }

  async send(content: string): Promise<Message> {
    return this.channel!.send(content);
  }

  async edit(message: Message, content: string): Promise<void> {
    await message.edit(content);
  }

  async sendComponents(options: MessageCreateOptions): Promise<Message> {
    return this.channel!.send(options);
  }

  async editComponents(message: Message, options: MessageEditOptions): Promise<void> {
    await message.edit(options);
  }

  sendTyping(): void {
    void this.channel?.sendTyping();
  }

  onMessage(callback: OnMessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  getBotUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  async destroy(): Promise<void> {
    this.messageCallbacks = [];
    this.client.destroy();
    this.channel = null;
    log.info("[bridge-sender] independent bot destroyed");
  }
}

// ── MainBotSender（fallback）────────────────────────────────────────────────

export class MainBotSender implements BridgeSender {
  readonly mode = "main-bot" as const;
  private channel: TextChannel | null = null;

  constructor(private readonly mainClient: Client) {}

  async init(channelId: string): Promise<void> {
    const ch = await this.mainClient.channels.fetch(channelId);
    if (!ch?.isTextBased() || ch.isDMBased()) {
      throw new Error(`[bridge-sender] channel ${channelId} 不是 guild text channel`);
    }
    this.channel = ch as TextChannel;
    log.info(`[bridge-sender] main-bot fallback → #${this.channel.name}`);
  }

  async reply(originalMessage: Message, content: string): Promise<Message> {
    return originalMessage.reply(content);
  }

  async send(content: string): Promise<Message> {
    return this.channel!.send(content);
  }

  async edit(message: Message, content: string): Promise<void> {
    await message.edit(content);
  }

  async sendComponents(options: MessageCreateOptions): Promise<Message> {
    return this.channel!.send(options);
  }

  async editComponents(message: Message, options: MessageEditOptions): Promise<void> {
    await message.edit(options);
  }

  sendTyping(): void {
    void this.channel?.sendTyping();
  }

  onMessage(_callback: OnMessageCallback): void {
    // MainBot 模式不自行監聽，由主 bot 的 discord.ts 路由處理
  }

  getBotUserId(): string | null {
    return this.mainClient.user?.id ?? null;
  }

  async destroy(): Promise<void> {
    this.channel = null;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createBridgeSender(
  mainClient: Client,
  config: { botToken?: string },
): BridgeSender {
  if (config.botToken) {
    return new IndependentBotSender(config.botToken);
  }
  return new MainBotSender(mainClient);
}
