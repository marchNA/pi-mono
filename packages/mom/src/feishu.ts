import { AppType, Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { toLocalISOString } from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Types (parallel to slack.ts)
// ============================================================================

export interface FeishuEvent {
	type: "mention" | "dm";
	channel: string; // chat_id
	ts: string;
	user: string; // open_id
	text: string;
	messageId: string; // feishu message_id for replies
	attachments?: Attachment[];
}

export interface FeishuUser {
	id: string; // open_id
	name: string;
}

export interface FeishuChannel {
	id: string; // chat_id
	name: string;
}

// Shared types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface FeishuContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MomHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: FeishuEvent, bot: FeishuBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: FeishuBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// FeishuBot
// ============================================================================

export class FeishuBot {
	private client: Client;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botOpenId: string | null = null;

	private users = new Map<string, FeishuUser>();
	private channels = new Map<string, FeishuChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(
		handler: MomHandler,
		config: { appId: string; appSecret: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.client = new Client({
			appId: config.appId,
			appSecret: config.appSecret,
			appType: AppType.SelfBuild,
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		// Verify client connectivity
		try {
			await this.client.contact.user.get({
				path: { user_id: "0" },
				params: { user_id_type: "open_id" },
			});
			log.logInfo("Feishu client initialized");
		} catch {
			log.logInfo("Feishu client initialized (bot info lookup skipped)");
		}

		// Set up event dispatcher
		const eventDispatcher = new EventDispatcher({});

		// Register message receive handler
		eventDispatcher.register({
			"im.message.receive_v1": (data) => {
				this.handleMessageEvent(data);
			},
		});

		// Create WebSocket client
		const appId = (this.client as any).appId as string;
		const appSecret = (this.client as any).appSecret as string;

		const wsClient = new WSClient({
			appId,
			appSecret,
			loggerLevel: 2 as any, // warn
		} as any);

		// WSClient.start() establishes the WebSocket connection and registers the event dispatcher
		await (wsClient as any).start({ eventDispatcher });

		log.logInfo("Feishu WebSocket client started");
		log.logConnected();
	}

	private async handleMessageEvent(data: any): Promise<void> {
		log.logInfo(`[feishu] Message event received: ${JSON.stringify(data).substring(0, 500)}`);

		const sender = data.sender;
		const message = data.message;

		if (!sender || !message) return;

		const senderId = sender.sender_id?.open_id;
		const senderType = sender.sender_type;

		// Skip bot's own messages
		if (senderType === "app") return;

		if (!senderId || !message.message_id) return;

		// Parse message content
		let text = "";
		try {
			if (message.message_type === "text") {
				const content = JSON.parse(message.content);
				text = content.text || "";
			} else {
				// For non-text messages, show type info
				text = `[${message.message_type} message]`;
			}
		} catch {
			text = message.content || "";
		}

		// Strip @mentions from text (飞书 mentions format: @_user_N)
		if (message.mentions && Array.isArray(message.mentions)) {
			for (const mention of message.mentions) {
				if (mention.key) {
					text = text.replace(mention.key, "").trim();
				}
			}
		}

		const chatType = message.chat_type; // "p2p" for DM, "group" for group
		const isDM = chatType === "p2p";

		// Cache user info from mentions
		if (message.mentions) {
			for (const mention of message.mentions) {
				const openId = mention.id?.open_id;
				if (openId && mention.name) {
					this.users.set(openId, { id: openId, name: mention.name });
				}
			}
		}

		const feishuEvent: FeishuEvent = {
			type: isDM ? "dm" : "mention",
			channel: message.chat_id,
			ts: message.create_time || Date.now().toString(),
			user: senderId,
			text: text.trim(),
			messageId: message.message_id,
		};

		// Log to log.jsonl
		this.logUserMessage(feishuEvent);

		// Check for stop command
		if (feishuEvent.text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(message.chat_id)) {
				this.handler.handleStop(message.chat_id, this);
			} else {
				this.postMessage(message.chat_id, "_Nothing running_");
			}
			return;
		}

		// For group chats, only respond to @mentions
		if (!isDM && (!message.mentions || !this.isBotMentioned(message.mentions))) {
			return;
		}

		// Check if busy
		if (this.handler.isRunning(message.chat_id)) {
			this.postMessage(message.chat_id, "Already working. Say stop to cancel.");
		} else {
			this.getQueue(message.chat_id).enqueue(() => this.handler.handleEvent(feishuEvent, this));
		}
	}

	private isBotMentioned(mentions: Array<{ name: string; id?: { open_id?: string } }>): boolean {
		// Check if any mention is for the bot
		// In feishu, the bot is mentioned when its name appears in mentions list
		// We check by sender_type or by matching bot's open_id
		if (this.botOpenId) {
			return mentions.some((m) => m.id?.open_id === this.botOpenId);
		}
		// If we don't know bot's open_id yet, assume any @mention in a group with the bot is for us
		return true;
	}

	getUser(userId: string): FeishuUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): FeishuChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): FeishuUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): FeishuChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(chatId: string, text: string): Promise<string> {
		try {
			const result = await this.client.im.message.create({
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
				params: {
					receive_id_type: "chat_id",
				},
			});
			return result?.data?.message_id || "";
		} catch (err) {
			log.logWarning("Failed to post message", err instanceof Error ? err.message : String(err));
			return "";
		}
	}

	async updateMessage(messageId: string, text: string): Promise<void> {
		try {
			await this.client.im.message.update({
				data: {
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
				path: {
					message_id: messageId,
				},
			});
		} catch (err) {
			log.logWarning("Failed to update message", err instanceof Error ? err.message : String(err));
		}
	}

	async deleteMessage(_chatId: string, messageId: string): Promise<void> {
		try {
			await this.client.im.message.delete({
				path: {
					message_id: messageId,
				},
			});
		} catch (err) {
			log.logWarning("Failed to delete message", err instanceof Error ? err.message : String(err));
		}
	}

	async replyMessage(messageId: string, text: string): Promise<string> {
		try {
			const result = await this.client.im.message.reply({
				data: {
					content: JSON.stringify({ text }),
					msg_type: "text",
				},
				path: {
					message_id: messageId,
				},
			});
			return result?.data?.message_id || "";
		} catch (err) {
			log.logWarning("Failed to reply message", err instanceof Error ? err.message : String(err));
			return "";
		}
	}

	async uploadFile(chatId: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		try {
			const fileContent = readFileSync(filePath);
			// Upload file to feishu
			const uploadResult = await this.client.im.file.create({
				data: {
					file_type: "stream",
					file_name: fileName,
					file: fileContent,
				},
			});
			const fileKey = uploadResult?.file_key;
			if (fileKey) {
				// Send file message
				await this.client.im.message.create({
					data: {
						receive_id: chatId,
						msg_type: "file",
						content: JSON.stringify({ file_key: fileKey }),
					},
					params: {
						receive_id_type: "chat_id",
					},
				});
			}
		} catch (err) {
			log.logWarning("Failed to upload file", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, messageId: string): void {
		this.logToFile(channel, {
			date: toLocalISOString(new Date()),
			ts: messageId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing.
	 */
	enqueueEvent(
		event: FeishuEvent | { type: "mention"; channel: string; user: string; text: string; ts: string },
	): boolean {
		const feishuEvent: FeishuEvent = {
			messageId: "",
			...event,
		};
		const queue = this.getQueue(feishuEvent.channel);
		if (queue.size() >= 5) {
			log.logWarning(
				`Event queue full for ${feishuEvent.channel}, discarding: ${feishuEvent.text.substring(0, 50)}`,
			);
			return false;
		}
		log.logInfo(`Enqueueing event for ${feishuEvent.channel}: ${feishuEvent.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(feishuEvent, this, true));
		return true;
	}

	// ==========================================================================
	// Private
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private logUserMessage(event: FeishuEvent): void {
		const user = this.users.get(event.user);
		this.logToFile(event.channel, {
			date: toLocalISOString(new Date()),
			ts: event.ts,
			user: event.user,
			userName: user?.name,
			text: event.text,
			attachments: event.attachments || [],
			isBot: false,
		});
	}
}
