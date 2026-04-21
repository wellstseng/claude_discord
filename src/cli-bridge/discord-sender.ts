/**
 * @file cli-bridge/discord-sender.ts
 * @description CLI Bridge 的 Discord 訊息發送抽象層
 *
 * 三種模式：
 * 1. IndependentBotSender — 有 botToken → 共用 Discord Client（SharedBotPool）
 *    同 token 多 channel 共用一個 Client，各自獨立 channel binding
 * 2. MainBotSender — fallback → 用主 bot 的 channel 直接發送
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type GuildTextBasedChannel,
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

  /** 回傳指向指定 channel 的 proxy sender（跨頻道 mention 用） */
  withChannel(channel: GuildTextBasedChannel): BridgeSender;

  /** 銷毀（logout / 清理） */
  destroy(): Promise<void>;
}

// ── Shared Bot Client Pool ──────────────────────────────────────────────────

interface SharedBotEntry {
  client: Client;
  refCount: number;
  ready: boolean;
  /** 所有掛在此 Client 上的 sender（messageCreate 分派用） */
  senders: Set<IndependentBotSender>;
}

const _botPool = new Map<string, SharedBotEntry>();

async function acquireSharedClient(botToken: string, sender: IndependentBotSender): Promise<Client> {
  let entry = _botPool.get(botToken);
  if (entry) {
    entry.refCount++;
    entry.senders.add(sender);
    if (!entry.ready) {
      await new Promise<void>((resolve) => {
        if (entry!.client.isReady()) { entry!.ready = true; resolve(); return; }
        entry!.client.once(Events.ClientReady, () => { entry!.ready = true; resolve(); });
      });
    }
    return entry.client;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  entry = { client, refCount: 1, ready: false, senders: new Set([sender]) };
  _botPool.set(botToken, entry);

  await client.login(botToken);
  await new Promise<void>((resolve) => {
    if (client.isReady()) { resolve(); return; }
    client.once(Events.ClientReady, () => resolve());
  });
  entry.ready = true;

  client.user?.setPresence({ status: "online" });

  // 全域 messageCreate — 分派給所有掛在此 Client 的 sender
  client.on("messageCreate", (msg) => {
    if (msg.author.id === client.user?.id) return;
    const poolEntry = _botPool.get(botToken);
    if (!poolEntry) return;
    for (const s of poolEntry.senders) {
      s.dispatchMessage(msg);
    }
  });

  log.info(`[bridge-sender] shared bot pool: ${client.user?.tag} 已建立（token=${botToken.slice(0, 8)}...）`);
  return client;
}

async function releaseSharedClient(botToken: string, sender: IndependentBotSender): Promise<void> {
  const entry = _botPool.get(botToken);
  if (!entry) return;
  entry.senders.delete(sender);
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.client.destroy();
    _botPool.delete(botToken);
    log.info(`[bridge-sender] shared bot pool: token=${botToken.slice(0, 8)}... 已銷毀（refCount=0）`);
  }
}

/** 清空 pool（graceful shutdown 用） */
export function destroyAllSharedClients(): void {
  for (const [token, entry] of _botPool) {
    entry.client.destroy();
    log.info(`[bridge-sender] shared bot pool: token=${token.slice(0, 8)}... 強制銷毀`);
  }
  _botPool.clear();
}

// ── IndependentBotSender ──────────────────────────────────────────────────────

export class IndependentBotSender implements BridgeSender {
  readonly mode = "independent-bot" as const;
  private client: Client | null = null;
  private channel: GuildTextBasedChannel | null = null;
  private messageCallbacks: OnMessageCallback[] = [];
  private _channelId: string | null = null;

  constructor(private readonly botToken: string) {}

  async init(channelId: string): Promise<void> {
    this._channelId = channelId;
    this.client = await acquireSharedClient(this.botToken, this);

    const ch = await this.client.channels.fetch(channelId);
    if (!ch?.isTextBased() || ch.isDMBased()) {
      throw new Error(`[bridge-sender] channel ${channelId} 不是 guild text channel`);
    }
    this.channel = ch;

    log.info(`[bridge-sender] independent bot ready: ${this.client.user?.tag} → #${this.channel.name}`);
  }

  /** 由 SharedBotPool 的 messageCreate 呼叫，分派訊息給此 sender 的 callbacks */
  dispatchMessage(msg: Message): void {
    for (const cb of this.messageCallbacks) {
      try { cb(msg); } catch (err) {
        log.error(`[bridge-sender] onMessage callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
    return this.client?.user?.id ?? null;
  }

  withChannel(channel: GuildTextBasedChannel): BridgeSender {
    return createChannelProxy(this, channel);
  }

  /** 取得底層 Discord Client（slash command 註冊用） */
  getClient(): Client {
    if (!this.client) throw new Error("[bridge-sender] client 尚未初始化");
    return this.client;
  }

  async destroy(): Promise<void> {
    this.messageCallbacks = [];
    this.channel = null;
    await releaseSharedClient(this.botToken, this);
    this.client = null;
    log.info("[bridge-sender] independent bot sender destroyed");
  }
}

// ── MainBotSender（fallback）────────────────────────────────────────────────

export class MainBotSender implements BridgeSender {
  readonly mode = "main-bot" as const;
  private channel: GuildTextBasedChannel | null = null;

  constructor(private readonly mainClient: Client) {}

  async init(channelId: string): Promise<void> {
    const ch = await this.mainClient.channels.fetch(channelId);
    if (!ch?.isTextBased() || ch.isDMBased()) {
      throw new Error(`[bridge-sender] channel ${channelId} 不是 guild text channel`);
    }
    this.channel = ch;
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
    // MainBot 模式不自行監聯，由主 bot 的 discord.ts 路由處理
  }

  getBotUserId(): string | null {
    return this.mainClient.user?.id ?? null;
  }

  withChannel(channel: GuildTextBasedChannel): BridgeSender {
    return createChannelProxy(this, channel);
  }

  async destroy(): Promise<void> {
    this.channel = null;
  }
}

// ── Channel Proxy ────────────────────────────────────────────────────────────

function createChannelProxy(base: BridgeSender, channel: GuildTextBasedChannel): BridgeSender {
  return {
    mode: base.mode,
    init: () => Promise.resolve(),
    reply: (_orig: Message, content: string) => channel.send(content),
    send: (content: string) => channel.send(content),
    edit: (message: Message, content: string) => message.edit(content).then(() => {}),
    sendComponents: (options: MessageCreateOptions) => channel.send(options),
    editComponents: (message: Message, options: MessageEditOptions) => message.edit(options).then(() => {}),
    sendTyping: () => { void channel.sendTyping(); },
    onMessage: () => {},
    getBotUserId: () => base.getBotUserId(),
    withChannel: (ch: GuildTextBasedChannel) => createChannelProxy(base, ch),
    destroy: () => Promise.resolve(),
  };
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
