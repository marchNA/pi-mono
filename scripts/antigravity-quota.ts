#!/usr/bin/env npx tsx
/**
 * Antigravity Quota Checker
 *
 * Standalone script to check Antigravity model quotas.
 *
 * Two modes:
 *   1. Local API (default if Antigravity is running) — queries the local language server
 *   2. Google Cloud Code API (--cloud) — OAuth login, works without Antigravity
 *
 * Usage:
 *   npx tsx scripts/antigravity-quota.ts            # auto-detect (local first, then cloud)
 *   npx tsx scripts/antigravity-quota.ts --local     # force local API
 *   npx tsx scripts/antigravity-quota.ts --cloud     # force Google Cloud Code API
 *   npx tsx scripts/antigravity-quota.ts --login     # force re-login (cloud mode)
 *   npx tsx scripts/antigravity-quota.ts --logout    # clear saved credentials
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

// ============================================================================
// OAuth configuration (same as AntigravityQuotaWatcher / vscode-antigravity-cockpit)
// ============================================================================

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const CLOUDCODE_BASE_URLS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const CREDENTIAL_PATH = path.join(os.homedir(), ".antigravity_quota_checker.json");
const CALLBACK_PORT_START = 11451;
const CALLBACK_PORT_RANGE = 100;

// ============================================================================
// Types
// ============================================================================

interface StoredCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
	email?: string;
	projectId?: string;
}

interface ModelQuota {
	label: string;
	modelId: string;
	remainingPercent: number;
	exhausted: boolean;
	resetTime: Date;
	hoursUntilReset: number;
}

interface QuotaReport {
	email?: string;
	plan?: string;
	projectId?: string;
	promptCredits?: { available: number; monthly: number; remainingPercent: number };
	flowCredits?: { available: number; monthly: number };
	models: ModelQuota[];
	source: "local" | "cloud";
}

// ============================================================================
// Utilities
// ============================================================================

function httpRequest(
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string | number>;
		body?: string;
		rejectUnauthorized?: boolean;
		timeout?: number;
	},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const isHttps = parsed.protocol === "https:";
		const client = isHttps ? https : http;

		const reqOptions: https.RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.pathname + parsed.search,
			method: options.method || "GET",
			headers: options.headers,
			rejectUnauthorized: options.rejectUnauthorized ?? true,
			timeout: options.timeout ?? 10000,
		};

		const req = client.request(reqOptions, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Request timeout"));
		});
		if (options.body) req.write(options.body);
		req.end();
	});
}

function bar(percent: number): string {
	const filled = Math.round(percent / 5);
	return "█".repeat(filled) + "░".repeat(20 - filled);
}

function formatHours(ms: number): string {
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	if (h > 24) return `${Math.floor(h / 24)}d${h % 24}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

// ============================================================================
// Credential storage
// ============================================================================

function loadCredential(): StoredCredential | null {
	try {
		if (!fs.existsSync(CREDENTIAL_PATH)) return null;
		return JSON.parse(fs.readFileSync(CREDENTIAL_PATH, "utf-8"));
	} catch {
		return null;
	}
}

function saveCredential(cred: StoredCredential): void {
	fs.writeFileSync(CREDENTIAL_PATH, JSON.stringify(cred, null, 2), "utf-8");
}

function deleteCredential(): void {
	try {
		fs.unlinkSync(CREDENTIAL_PATH);
	} catch {
		// ignore
	}
}

// ============================================================================
// OAuth flow
// ============================================================================

async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	const params = new URLSearchParams({
		client_id: OAUTH_CLIENT_ID,
		client_secret: OAUTH_CLIENT_SECRET,
		refresh_token: cred.refreshToken,
		grant_type: "refresh_token",
	});

	const resp = await httpRequest(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (resp.status !== 200) {
		const errBody = resp.body.toLowerCase();
		if (errBody.includes("invalid_grant")) {
			throw new Error("Refresh token expired. Please re-login with --login");
		}
		throw new Error(`Token refresh failed (${resp.status}): ${resp.body}`);
	}

	const data = JSON.parse(resp.body);
	cred.accessToken = data.access_token;
	cred.expiresAt = Date.now() + data.expires_in * 1000;
	saveCredential(cred);
	return cred;
}

async function getValidToken(): Promise<StoredCredential> {
	const cred = loadCredential();
	if (!cred) throw new Error("Not logged in. Run with --cloud or --login first.");

	// Refresh if expiring within 5 minutes
	if (Date.now() > cred.expiresAt - 5 * 60 * 1000) {
		console.log("Refreshing access token...");
		return refreshAccessToken(cred);
	}
	return cred;
}

function startCallbackServer(): Promise<{ server: http.Server; port: number }> {
	return new Promise((resolve, reject) => {
		let port = CALLBACK_PORT_START;
		let attempts = 0;

		const tryPort = () => {
			if (attempts >= CALLBACK_PORT_RANGE) {
				reject(new Error("No available port for OAuth callback"));
				return;
			}
			const server = http.createServer();
			server.on("error", (err: NodeJS.ErrnoException) => {
				server.close();
				if (err.code === "EADDRINUSE") {
					port++;
					attempts++;
					tryPort();
				} else {
					reject(err);
				}
			});
			server.listen(port, "127.0.0.1", () => resolve({ server, port }));
		};
		tryPort();
	});
}

async function oauthLogin(): Promise<StoredCredential> {
	const crypto = await import("crypto");
	const { server, port } = await startCallbackServer();
	const redirectUri = `http://127.0.0.1:${port}`;
	const state = crypto.randomBytes(16).toString("hex");

	const params = new URLSearchParams({
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: OAUTH_SCOPES.join(" "),
		state,
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
	});
	const authUrl = `${AUTH_URL}?${params.toString()}`;

	console.log("\nOpening browser for Google authorization...\n");
	console.log("If the browser does not open, visit this URL manually:");
	console.log(authUrl);
	console.log();

	// Open browser
	try {
		const platform = process.platform;
		if (platform === "win32") execSync(`start "" "${authUrl}"`);
		else if (platform === "darwin") execSync(`open "${authUrl}"`);
		else execSync(`xdg-open "${authUrl}"`);
	} catch {
		// Browser open failed, user can use the URL above
	}

	// Wait for callback
	const code = await new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			server.close();
			reject(new Error("Authorization timeout (5 minutes)"));
		}, 5 * 60 * 1000);

		server.on("request", (req, res) => {
			const url = new URL(req.url || "", redirectUri);
			const callbackCode = url.searchParams.get("code");
			const callbackState = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<h1>Authorization failed</h1><p>You can close this page.</p>");
				clearTimeout(timeout);
				server.close();
				reject(new Error(`OAuth error: ${error}`));
				return;
			}

			if (callbackCode && callbackState === state) {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					"<h1>Authorization successful!</h1><p>You can close this page and return to the terminal.</p><script>setTimeout(()=>window.close(),2000)</script>",
				);
				clearTimeout(timeout);
				server.close();
				resolve(callbackCode);
			} else {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<h1>Invalid request</h1>");
			}
		});
	});

	console.log("Exchanging authorization code for token...");

	// Exchange code for token
	const tokenParams = new URLSearchParams({
		client_id: OAUTH_CLIENT_ID,
		client_secret: OAUTH_CLIENT_SECRET,
		code,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
	});

	const tokenResp = await httpRequest(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: tokenParams.toString(),
	});

	if (tokenResp.status !== 200) {
		throw new Error(`Token exchange failed: ${tokenResp.body}`);
	}

	const tokenData = JSON.parse(tokenResp.body);
	if (!tokenData.refresh_token) {
		throw new Error("No refresh_token received. Try again.");
	}

	const cred: StoredCredential = {
		accessToken: tokenData.access_token,
		refreshToken: tokenData.refresh_token,
		expiresAt: Date.now() + tokenData.expires_in * 1000,
	};

	// Fetch user email
	try {
		const userResp = await httpRequest(USERINFO_URL, {
			headers: { Authorization: `Bearer ${cred.accessToken}` },
		});
		if (userResp.status === 200) {
			cred.email = JSON.parse(userResp.body).email;
		}
	} catch {
		// email is optional
	}

	saveCredential(cred);
	console.log(`\nLogged in as: ${cred.email || "(unknown)"}`);
	console.log(`Credentials saved to: ${CREDENTIAL_PATH}\n`);
	return cred;
}

// ============================================================================
// Cloud Code API (mode: cloud)
// ============================================================================

async function cloudLoadProjectInfo(accessToken: string): Promise<{ projectId?: string; tier?: string }> {
	const body = JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });

	for (const baseUrl of CLOUDCODE_BASE_URLS) {
		try {
			const resp = await httpRequest(`${baseUrl}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"User-Agent": "antigravity",
				},
				body,
			});
			if (resp.status === 200) {
				const data = JSON.parse(resp.body);
				return {
					projectId: typeof data.cloudaicompanionProject === "string" ? data.cloudaicompanionProject : undefined,
					tier: data.paidTier?.id || data.paidTier?.name || data.currentTier?.id || data.currentTier?.name,
				};
			}
			if (resp.status === 401) throw new Error("Authorization expired. Run with --login");
		} catch (e) {
			if (e instanceof Error && e.message.includes("Authorization expired")) throw e;
			// try next base URL
		}
	}
	throw new Error("Failed to load project info from all Cloud Code endpoints");
}

async function cloudFetchModels(
	accessToken: string,
	projectId?: string,
): Promise<Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>> {
	const body = JSON.stringify(projectId ? { project: projectId } : {});

	for (const baseUrl of CLOUDCODE_BASE_URLS) {
		try {
			const resp = await httpRequest(`${baseUrl}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"User-Agent": "antigravity",
				},
				body,
			});
			if (resp.status === 200) {
				const data = JSON.parse(resp.body);
				return data.models || {};
			}
			if (resp.status === 401) throw new Error("Authorization expired. Run with --login");
			if (resp.status === 403) {
				// Try next endpoint
				continue;
			}
		} catch (e) {
			if (e instanceof Error && e.message.includes("Authorization expired")) throw e;
			// try next base URL
		}
	}
	throw new Error("Failed to fetch models from all Cloud Code endpoints");
}

async function fetchQuotaCloud(forceLogin: boolean): Promise<QuotaReport> {
	let cred: StoredCredential;
	if (forceLogin || !loadCredential()) {
		cred = await oauthLogin();
	} else {
		cred = await getValidToken();
	}

	console.log("Fetching project info...");
	const projectInfo = await cloudLoadProjectInfo(cred.accessToken);
	if (projectInfo.projectId) {
		cred.projectId = projectInfo.projectId;
		saveCredential(cred);
	}

	console.log("Fetching model quotas...");
	const modelsMap = await cloudFetchModels(cred.accessToken, projectInfo.projectId);

	const allowedPattern = /gemini|claude|gpt/i;
	const models: ModelQuota[] = [];
	for (const [name, info] of Object.entries(modelsMap)) {
		if (!allowedPattern.test(name)) continue;
		const qi = info.quotaInfo;
		const remaining = qi?.remainingFraction ?? 0;
		const resetTime = qi?.resetTime ? new Date(qi.resetTime) : new Date(Date.now() + 86400000);
		const hoursUntilReset = Math.max(0, (resetTime.getTime() - Date.now()) / 3600000);

		// Format display name: gemini-3.0-flash -> Gemini 3.0 Flash
		const displayName = name
			.replace(/(\d+)-(\d+)/g, "$1.$2")
			.split("-")
			.map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
			.join(" ");

		models.push({
			label: displayName,
			modelId: name,
			remainingPercent: remaining * 100,
			exhausted: remaining <= 0,
			resetTime,
			hoursUntilReset,
		});
	}

	// Sort: exhausted last, then by name
	models.sort((a, b) => {
		if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
		return a.label.localeCompare(b.label);
	});

	return {
		email: cred.email,
		plan: projectInfo.tier,
		projectId: projectInfo.projectId,
		models,
		source: "cloud",
	};
}

// ============================================================================
// Local API (mode: local)
// ============================================================================

interface ProcessInfo {
	pid: number;
	extensionPort: number;
	csrfToken: string;
}

function detectAntigravityProcess(): ProcessInfo | null {
	if (process.platform !== "win32") {
		// Unix: use ps
		try {
			const stdout = execSync("ps aux", { encoding: "utf-8", timeout: 5000 });
			for (const line of stdout.split("\n")) {
				if (!line.includes("language_server") || !line.includes("antigravity")) continue;
				const tokenMatch = line.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
				const portMatch = line.match(/--extension_server_port[=\s]+(\d+)/);
				const pidMatch = line.match(/^\S+\s+(\d+)/);
				if (tokenMatch && pidMatch) {
					return {
						pid: parseInt(pidMatch[1], 10),
						extensionPort: portMatch ? parseInt(portMatch[1], 10) : 0,
						csrfToken: tokenMatch[1],
					};
				}
			}
		} catch {
			// ignore
		}
		return null;
	}

	// Windows: use PowerShell
	try {
		const psScript = `Get-CimInstance Win32_Process -Filter "name='language_server_windows_x64.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json`;
		const stdout = execSync(`powershell -NoProfile -Command "${psScript}"`, {
			encoding: "utf-8",
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!stdout.trim()) return null;

		let items = JSON.parse(stdout.trim());
		if (!Array.isArray(items)) items = [items];

		for (const item of items) {
			const cmd = item.CommandLine || "";
			if (!cmd.toLowerCase().includes("antigravity")) continue;
			const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
			const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
			if (tokenMatch) {
				return {
					pid: item.ProcessId,
					extensionPort: portMatch ? parseInt(portMatch[1], 10) : 0,
					csrfToken: tokenMatch[1],
				};
			}
		}
	} catch {
		// ignore
	}
	return null;
}

async function findWorkingPort(pid: number, csrfToken: string): Promise<number | null> {
	// Get listening ports for the process
	let ports: number[] = [];

	if (process.platform === "win32") {
		try {
			const stdout = execSync(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`, {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?]):(\d+)\s+\S+\s+LISTENING/gi;
			let match;
			while ((match = portRegex.exec(stdout)) !== null) {
				const p = parseInt(match[1], 10);
				if (!ports.includes(p)) ports.push(p);
			}

			// Fallback: simpler regex
			if (ports.length === 0) {
				for (const line of stdout.split("\n")) {
					const m = line.match(/:(\d+)\s/);
					if (m) {
						const p = parseInt(m[1], 10);
						if (!ports.includes(p)) ports.push(p);
					}
				}
			}
		} catch {
			// ignore
		}
	} else {
		try {
			const stdout = execSync(`lsof -i -P -n -p ${pid} | grep LISTEN`, {
				encoding: "utf-8",
				timeout: 5000,
			});
			for (const line of stdout.split("\n")) {
				const m = line.match(/:(\d+)\s/);
				if (m) {
					const p = parseInt(m[1], 10);
					if (!ports.includes(p)) ports.push(p);
				}
			}
		} catch {
			// ignore
		}
	}

	ports.sort((a, b) => a - b);

	// Test each port
	for (const port of ports) {
		try {
			const body = JSON.stringify({
				metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "1.0", locale: "en" },
			});
			const resp = await httpRequest(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					"X-Codeium-Csrf-Token": csrfToken,
				},
				body,
				rejectUnauthorized: false,
				timeout: 3000,
			});
			if (resp.status === 200) return port;
		} catch {
			// try next
		}
	}
	return null;
}

async function fetchQuotaLocal(): Promise<QuotaReport> {
	console.log("Detecting Antigravity process...");
	const proc = detectAntigravityProcess();
	if (!proc) throw new Error("Antigravity is not running. Use --cloud mode instead.");

	console.log(`Found process PID=${proc.pid}, finding API port...`);
	const port = await findWorkingPort(proc.pid, proc.csrfToken);
	if (!port) throw new Error("Could not find a working API port for Antigravity.");

	console.log(`Connected to local API on port ${port}`);

	const body = JSON.stringify({
		metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "1.0", locale: "en" },
	});

	const resp = await httpRequest(
		`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
				"X-Codeium-Csrf-Token": proc.csrfToken,
			},
			body,
			rejectUnauthorized: false,
			timeout: 10000,
		},
	);

	if (resp.status !== 200) throw new Error(`Local API returned ${resp.status}: ${resp.body}`);

	const data = JSON.parse(resp.body);
	const us = data.userStatus;
	const ps = us?.planStatus;
	const configs = us?.cascadeModelConfigData?.clientModelConfigs || [];

	const models: ModelQuota[] = [];
	for (const cfg of configs) {
		const qi = cfg.quotaInfo;
		if (!qi) continue;
		const remaining = (qi.remainingFraction ?? 0) * 100;
		const resetTime = qi.resetTime ? new Date(qi.resetTime) : new Date(Date.now() + 86400000);
		const hoursUntilReset = Math.max(0, (resetTime.getTime() - Date.now()) / 3600000);

		models.push({
			label: cfg.label || cfg.modelOrAlias?.model || "unknown",
			modelId: cfg.modelOrAlias?.model || "",
			remainingPercent: remaining,
			exhausted: remaining <= 0,
			resetTime,
			hoursUntilReset,
		});
	}

	const promptCredits =
		ps?.planInfo?.monthlyPromptCredits > 0
			? {
					available: ps.availablePromptCredits ?? 0,
					monthly: ps.planInfo.monthlyPromptCredits,
					remainingPercent: ((ps.availablePromptCredits ?? 0) / ps.planInfo.monthlyPromptCredits) * 100,
				}
			: undefined;

	const flowCredits =
		ps?.planInfo?.monthlyFlowCredits > 0
			? {
					available: ps.availableFlowCredits ?? 0,
					monthly: ps.planInfo.monthlyFlowCredits,
				}
			: undefined;

	return {
		email: us?.email,
		plan: ps?.planInfo?.planName || us?.userTier?.name,
		models,
		promptCredits,
		flowCredits,
		source: "local",
	};
}

// ============================================================================
// Display
// ============================================================================

function printReport(report: QuotaReport): void {
	console.log();
	console.log("==========================================");
	console.log("  Antigravity Quota Report");
	console.log("==========================================");
	console.log();
	console.log(`Source:  ${report.source === "local" ? "Local API" : "Google Cloud Code API"}`);
	if (report.email) console.log(`Account: ${report.email}`);
	if (report.plan) console.log(`Plan:    ${report.plan}`);
	if (report.projectId) console.log(`Project: ${report.projectId}`);

	if (report.promptCredits) {
		console.log();
		console.log("--- Prompt Credits ---");
		console.log(`Monthly:   ${report.promptCredits.monthly}`);
		console.log(`Available: ${report.promptCredits.available}`);
		console.log(`Used:      ${report.promptCredits.monthly - report.promptCredits.available}`);
		const pct = report.promptCredits.remainingPercent;
		console.log(`Remaining: ${bar(pct)} ${pct.toFixed(1)}%${pct < 5 ? " ⚠️" : ""}`);
	}

	if (report.flowCredits) {
		console.log();
		console.log("--- Flow Credits ---");
		console.log(`Monthly:   ${report.flowCredits.monthly}`);
		console.log(`Available: ${report.flowCredits.available}`);
	}

	console.log();
	console.log("--- Model Quotas ---");
	console.log();

	if (report.models.length === 0) {
		console.log("  No models found.");
	}

	for (const m of report.models) {
		const pct = m.remainingPercent;
		const status = m.exhausted ? " ❌ EXHAUSTED" : "";
		console.log(`${m.label}`);
		console.log(`  ${bar(pct)} ${pct.toFixed(0)}%${status}`);
		console.log(`  Reset: ${m.resetTime.toLocaleString()} (${formatHours(m.hoursUntilReset * 3600000)})`);
		console.log();
	}
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const forceLocal = args.includes("--local");
	const forceCloud = args.includes("--cloud");
	const forceLogin = args.includes("--login");
	const logout = args.includes("--logout");

	if (args.includes("--help") || args.includes("-h")) {
		console.log(`
Antigravity Quota Checker

Usage:
  npx tsx scripts/antigravity-quota.ts [options]

Options:
  --local    Force local API mode (requires Antigravity running)
  --cloud    Force Google Cloud Code API mode (OAuth login)
  --login    Force re-login (cloud mode)
  --logout   Clear saved credentials
  --help     Show this help
`);
		return;
	}

	if (logout) {
		deleteCredential();
		console.log("Credentials cleared.");
		return;
	}

	let report: QuotaReport;

	if (forceLocal) {
		report = await fetchQuotaLocal();
	} else if (forceCloud || forceLogin) {
		report = await fetchQuotaCloud(forceLogin);
	} else {
		// Auto-detect: try local first, then cloud
		try {
			report = await fetchQuotaLocal();
		} catch {
			console.log("Antigravity not running, switching to cloud mode...\n");
			report = await fetchQuotaCloud(false);
		}
	}

	printReport(report);
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});
