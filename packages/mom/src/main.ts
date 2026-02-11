#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import {
	type FeishuBot,
	FeishuBot as FeishuBotClass,
	type FeishuEvent,
	type MomHandler as FeishuMomHandler,
} from "./feishu.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import {
	type SlackBot,
	SlackBot as SlackBotClass,
	type SlackEvent,
	type MomHandler as SlackMomHandler,
} from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const MOM_FEISHU_APP_ID = process.env.MOM_FEISHU_APP_ID;
const MOM_FEISHU_APP_SECRET = process.env.MOM_FEISHU_APP_SECRET;

type Platform = "slack" | "feishu";

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	platform?: Platform;
	daemon: boolean;
	stopDaemon: boolean;
	statusDaemon: boolean;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let platform: Platform | undefined;
	let daemon = false;
	let stopDaemon = false;
	let statusDaemon = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--platform=")) {
			const value = arg.slice("--platform=".length);
			if (value !== "slack" && value !== "feishu") {
				console.error(`Error: Invalid platform '${value}'. Use 'slack' or 'feishu'`);
				process.exit(1);
			}
			platform = value;
		} else if (arg === "--platform") {
			const value = args[++i];
			if (value !== "slack" && value !== "feishu") {
				console.error(`Error: Invalid platform '${value}'. Use 'slack' or 'feishu'`);
				process.exit(1);
			}
			platform = value;
		} else if (arg === "--daemon") {
			daemon = true;
		} else if (arg === "--stop-daemon") {
			stopDaemon = true;
		} else if (arg === "--status") {
			statusDaemon = true;
		} else if (arg === "--_daemon-child") {
			// Internal flag: child process of --daemon, skip daemon fork
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		platform,
		daemon,
		stopDaemon,
		statusDaemon,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode (Slack only)
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// ============================================================================
// Daemon helpers
// ============================================================================

const defaultWorkingDir = join(homedir(), ".pi", "mom", "data");

function resolveWorkingDir(dir: string | undefined): string {
	return dir ?? defaultWorkingDir;
}

function getPidFilePath(dir: string): string {
	return join(dir, "mom.pid");
}

function getLogFilePath(dir: string): string {
	return join(dir, "mom.log");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPidFile(dir: string): number | null {
	const pidFile = getPidFilePath(dir);
	if (!existsSync(pidFile)) return null;
	const content = readFileSync(pidFile, "utf-8").trim();
	const pid = parseInt(content, 10);
	if (Number.isNaN(pid)) return null;
	return pid;
}

function cleanupPidFile(dir: string): void {
	const pidFile = getPidFilePath(dir);
	if (existsSync(pidFile)) {
		try {
			unlinkSync(pidFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}

// Handle --stop-daemon
if (parsedArgs.stopDaemon) {
	const dir = resolveWorkingDir(parsedArgs.workingDir);
	const pid = readPidFile(dir);
	if (pid === null) {
		console.error(`No PID file found at ${getPidFilePath(dir)}`);
		process.exit(1);
	}
	if (!isProcessAlive(pid)) {
		console.log(`Process ${pid} is not running. Removing stale PID file.`);
		unlinkSync(getPidFilePath(dir));
		process.exit(0);
	}
	try {
		process.kill(pid, "SIGTERM");
		console.log(`Sent SIGTERM to process ${pid}. Mom bot stopping.`);
		// Wait briefly and verify
		await new Promise((r) => setTimeout(r, 1000));
		if (!isProcessAlive(pid)) {
			console.log("Process stopped.");
			if (existsSync(getPidFilePath(dir))) {
				unlinkSync(getPidFilePath(dir));
			}
		} else {
			console.log(`Process ${pid} still running. It may take a moment to shut down.`);
		}
	} catch (err) {
		console.error(`Failed to stop process ${pid}:`, err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	process.exit(0);
}

// Handle --status
if (parsedArgs.statusDaemon) {
	const dir = resolveWorkingDir(parsedArgs.workingDir);
	const pid = readPidFile(dir);
	if (pid === null) {
		console.log("Mom bot is not running (no PID file).");
		process.exit(1);
	}
	if (isProcessAlive(pid)) {
		console.log(`Mom bot is running (PID: ${pid}).`);
		console.log(`  Log file: ${getLogFilePath(dir)}`);
		process.exit(0);
	} else {
		console.log(`Mom bot is not running (stale PID: ${pid}). Removing PID file.`);
		unlinkSync(getPidFilePath(dir));
		process.exit(1);
	}
}

// Handle --daemon: re-spawn self in background with stdio redirected to log file
if (parsedArgs.daemon) {
	const dir = resolveWorkingDir(parsedArgs.workingDir);

	// Check if already running
	const existingPid = readPidFile(dir);
	if (existingPid !== null && isProcessAlive(existingPid)) {
		console.error(`Mom bot is already running (PID: ${existingPid}). Stop it first with: mom --stop-daemon ${dir}`);
		process.exit(1);
	}

	// Ensure working dir exists
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Build child args: same as current args but without --daemon
	const childArgs = process.argv.slice(2).filter((a) => a !== "--daemon");
	// If no working dir was specified, append the default
	if (!parsedArgs.workingDir) {
		childArgs.push(dir);
	}
	// Add internal flag so child knows it's the daemon child
	childArgs.push("--_daemon-child");

	const logFile = getLogFilePath(dir);
	const logFd = openSync(logFile, "a");

	const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: process.env,
		cwd: process.cwd(),
	});

	if (child.pid) {
		writeFileSync(getPidFilePath(dir), String(child.pid), "utf-8");
		console.log(`Mom bot started in background (PID: ${child.pid}).`);
		console.log(`  Log file: ${logFile}`);
		console.log(`  Stop with: mom --stop-daemon ${dir}`);
		console.log(`  Status:    mom --status ${dir}`);
	}

	child.unref();
	process.exit(0);
}

// Normal bot mode - use default working dir if not specified
const { workingDir, sandbox } = {
	workingDir: resolveWorkingDir(parsedArgs.workingDir),
	sandbox: parsedArgs.sandbox,
};

await validateSandbox(sandbox);

// ============================================================================
// Load settings from settings.json (env vars take priority)
// ============================================================================

import { MomSettingsManager } from "./context.js";

// ============================================================================
// Check settings files, prompt to create if missing
// ============================================================================

// Detect if running as daemon child (no interactive stdin)
const isDaemonChild = process.argv.includes("--_daemon-child");

async function askYesNo(question: string): Promise<boolean> {
	// In daemon mode, no stdin available - auto-accept
	if (isDaemonChild) {
		console.log(`${question} (y/n) y [auto: daemon mode]`);
		return true;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} (y/n) `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}

const userSettingsDir = join(homedir(), ".pi", "mom");
const userSettingsPath = join(userSettingsDir, "settings.json");

if (!existsSync(userSettingsPath)) {
	console.log(`User settings not found: ${userSettingsPath}`);
	const shouldCreate = await askYesNo("Create default settings file?");
	if (shouldCreate) {
		if (!existsSync(userSettingsDir)) {
			mkdirSync(userSettingsDir, { recursive: true });
		}
		const defaultSettings = {
			platform: "feishu",
			slack: {
				appToken: "",
				botToken: "",
			},
			feishu: {
				appId: "",
				appSecret: "",
			},
		};
		writeFileSync(userSettingsPath, JSON.stringify(defaultSettings, null, 2), "utf-8");
		console.log(`Created: ${userSettingsPath}`);
		console.log("Edit the file to add your credentials, then restart.");
		process.exit(0);
	}
}

if (!existsSync(join(workingDir, "settings.json"))) {
	console.log(`Workspace settings not found: ${join(workingDir, "settings.json")}`);
	const shouldCreate = await askYesNo("Create default workspace settings file?");
	if (shouldCreate) {
		if (!existsSync(workingDir)) {
			mkdirSync(workingDir, { recursive: true });
		}
		writeFileSync(join(workingDir, "settings.json"), "{}\n", "utf-8");
		console.log(`Created: ${join(workingDir, "settings.json")}`);
	}
}

const settingsManager = new MomSettingsManager(workingDir);
const settingsPlatform = settingsManager.getPlatform();
const slackConfig = settingsManager.getSlackConfig();
const feishuConfig = settingsManager.getFeishuConfig();

// Priority: CLI arg > settings.json > default("feishu")
const platform: Platform = parsedArgs.platform ?? settingsPlatform ?? "feishu";

// Merge: env vars override settings.json
const resolvedSlackAppToken = MOM_SLACK_APP_TOKEN || slackConfig.appToken;
const resolvedSlackBotToken = MOM_SLACK_BOT_TOKEN || slackConfig.botToken;
const resolvedFeishuAppId = MOM_FEISHU_APP_ID || feishuConfig.appId;
const resolvedFeishuAppSecret = MOM_FEISHU_APP_SECRET || feishuConfig.appSecret;

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string, botToken?: string, platform: "slack" | "feishu" = "slack"): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, platform),
			store: new ChannelStore({ workingDir, botToken: botToken || "" }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Start platform
// ============================================================================

if (platform === "feishu") {
	await startFeishu();
} else {
	await startSlack();
}

// ============================================================================
// Slack
// ============================================================================

async function startSlack(): Promise<void> {
	if (!resolvedSlackAppToken || !resolvedSlackBotToken) {
		console.error(
			"Missing Slack credentials. Set env vars (MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN) or configure in settings.json:",
		);
		console.error('  { "slack": { "appToken": "xapp-...", "botToken": "xoxb-..." } }');
		process.exit(1);
	}

	function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
		let messageTs: string | null = null;
		const threadMessageTs: string[] = [];
		let accumulatedText = "";
		let isWorking = true;
		const workingIndicator = " ...";
		let updatePromise = Promise.resolve();

		const user = slack.getUser(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: user?.userName,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments || []).map((a) => ({ local: a.local })),
			},
			channelName: slack.getChannel(event.channel)?.name,
			store: state.store,
			channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

			respond: async (text: string, shouldLog = true) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}

					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs);
					}
				});
				await updatePromise;
			},

			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}
				});
				await updatePromise;
			},

			respondInThread: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageTs) {
						const ts = await slack.postInThread(event.channel, messageTs, text);
						threadMessageTs.push(ts);
					}
				});
				await updatePromise;
			},

			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageTs) {
					updatePromise = updatePromise.then(async () => {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
						}
					});
					await updatePromise;
				}
			},

			uploadFile: async (filePath: string, title?: string) => {
				await slack.uploadFile(event.channel, filePath, title);
			},

			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				});
				await updatePromise;
			},

			deleteMessage: async () => {
				updatePromise = updatePromise.then(async () => {
					for (let i = threadMessageTs.length - 1; i >= 0; i--) {
						try {
							await slack.deleteMessage(event.channel, threadMessageTs[i]);
						} catch {
							// Ignore
						}
					}
					threadMessageTs.length = 0;
					if (messageTs) {
						await slack.deleteMessage(event.channel, messageTs);
						messageTs = null;
					}
				});
				await updatePromise;
			},
		};
	}

	const handler: SlackMomHandler = {
		isRunning(channelId: string): boolean {
			const state = channelStates.get(channelId);
			return state?.running ?? false;
		},

		async handleStop(channelId: string, slack: SlackBot): Promise<void> {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				const ts = await slack.postMessage(channelId, "_Stopping..._");
				state.stopMessageTs = ts;
			} else {
				await slack.postMessage(channelId, "_Nothing running_");
			}
		},

		async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
			const state = getState(event.channel, resolvedSlackBotToken!);

			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

			try {
				const ctx = createSlackContext(event, slack, state, isEvent);

				await ctx.setTyping(true);
				await ctx.setWorking(true);
				const result = await state.runner.run(ctx as any, state.store);
				await ctx.setWorking(false);

				if (result.stopReason === "aborted" && state.stopRequested) {
					if (state.stopMessageTs) {
						await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
						state.stopMessageTs = undefined;
					} else {
						await slack.postMessage(event.channel, "_Stopped_");
					}
				}
			} catch (err) {
				log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
			} finally {
				state.running = false;
			}
		},
	};

	log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

	const sharedStore = new ChannelStore({ workingDir, botToken: resolvedSlackBotToken! });

	const bot = new SlackBotClass(handler, {
		appToken: resolvedSlackAppToken,
		botToken: resolvedSlackBotToken,
		workingDir,
		store: sharedStore,
	});

	const eventsWatcher = createEventsWatcher(workingDir, bot);
	eventsWatcher.start();

	process.on("SIGINT", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		cleanupPidFile(workingDir);
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		cleanupPidFile(workingDir);
		process.exit(0);
	});

	bot.start();
}

// ============================================================================
// Feishu
// ============================================================================

async function startFeishu(): Promise<void> {
	if (!resolvedFeishuAppId || !resolvedFeishuAppSecret) {
		console.error(
			"Missing Feishu credentials. Set env vars (MOM_FEISHU_APP_ID, MOM_FEISHU_APP_SECRET) or configure in settings.json:",
		);
		console.error('  { "platform": "feishu", "feishu": { "appId": "cli_xxx", "appSecret": "xxx" } }');
		process.exit(1);
	}

	function createFeishuContext(event: FeishuEvent, bot: FeishuBot, state: ChannelState, isEvent?: boolean) {
		let messageId: string | null = null;
		const threadMessageIds: string[] = [];
		let accumulatedText = "";
		let isWorking = true;
		const workingIndicator = " ...";
		let updatePromise = Promise.resolve();

		const user = bot.getUser(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: user?.name,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments || []).map((a) => ({ local: a.local })),
			},
			channelName: bot.getChannel(event.channel)?.name,
			store: state.store,
			channels: bot.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			users: bot.getAllUsers().map((u) => ({ id: u.id, userName: u.name, displayName: u.name })),

			respond: async (text: string, shouldLog = true) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageId) {
						await bot.updateMessage(messageId, displayText);
					} else {
						messageId = await bot.postMessage(event.channel, displayText);
					}

					if (shouldLog && messageId) {
						bot.logBotResponse(event.channel, text, messageId);
					}
				});
				await updatePromise;
			},

			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					if (messageId) {
						await bot.updateMessage(messageId, displayText);
					} else {
						messageId = await bot.postMessage(event.channel, displayText);
					}
				});
				await updatePromise;
			},

			respondInThread: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageId) {
						const replyId = await bot.replyMessage(messageId, text);
						if (replyId) threadMessageIds.push(replyId);
					}
				});
				await updatePromise;
			},

			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageId) {
					updatePromise = updatePromise.then(async () => {
						if (!messageId) {
							accumulatedText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking...";
							messageId = await bot.postMessage(event.channel, accumulatedText + workingIndicator);
						}
					});
					await updatePromise;
				}
			},

			uploadFile: async (filePath: string, title?: string) => {
				await bot.uploadFile(event.channel, filePath, title);
			},

			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					if (messageId) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await bot.updateMessage(messageId, displayText);
					}
				});
				await updatePromise;
			},

			deleteMessage: async () => {
				updatePromise = updatePromise.then(async () => {
					for (let i = threadMessageIds.length - 1; i >= 0; i--) {
						try {
							await bot.deleteMessage(event.channel, threadMessageIds[i]);
						} catch {
							// Ignore
						}
					}
					threadMessageIds.length = 0;
					if (messageId) {
						await bot.deleteMessage(event.channel, messageId);
						messageId = null;
					}
				});
				await updatePromise;
			},
		};
	}

	const handler: FeishuMomHandler = {
		isRunning(channelId: string): boolean {
			const state = channelStates.get(channelId);
			return state?.running ?? false;
		},

		async handleStop(channelId: string, bot: FeishuBot): Promise<void> {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				const msgId = await bot.postMessage(channelId, "Stopping...");
				state.stopMessageTs = msgId;
			} else {
				await bot.postMessage(channelId, "Nothing running");
			}
		},

		async handleEvent(event: FeishuEvent, bot: FeishuBot, isEvent?: boolean): Promise<void> {
			const state = getState(event.channel, undefined, "feishu");

			state.running = true;
			state.stopRequested = false;

			log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

			try {
				const ctx = createFeishuContext(event, bot, state, isEvent);

				await ctx.setTyping(true);
				await ctx.setWorking(true);
				const result = await state.runner.run(ctx as any, state.store);
				await ctx.setWorking(false);

				if (result.stopReason === "aborted" && state.stopRequested) {
					if (state.stopMessageTs) {
						await bot.updateMessage(state.stopMessageTs, "Stopped");
						state.stopMessageTs = undefined;
					} else {
						await bot.postMessage(event.channel, "Stopped");
					}
				}
			} catch (err) {
				log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
			} finally {
				state.running = false;
			}
		},
	};

	log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
	log.logInfo("Platform: Feishu");

	const sharedStore = new ChannelStore({ workingDir, botToken: "" });

	const bot = new FeishuBotClass(handler, {
		appId: resolvedFeishuAppId,
		appSecret: resolvedFeishuAppSecret,
		workingDir,
		store: sharedStore,
	});

	const eventsWatcher = createEventsWatcher(workingDir, bot);
	eventsWatcher.start();

	process.on("SIGINT", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		cleanupPidFile(workingDir);
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		cleanupPidFile(workingDir);
		process.exit(0);
	});

	bot.start();
}
