/**
 * Local Image Generation Extension
 *
 * Generates images via a local OpenAI-compatible API (chat completions).
 * Returns images as tool result attachments for inline terminal rendering.
 *
 * Usage:
 *   "Generate an image of a sunset over mountains"
 *   "Create a 16:9 wallpaper of a cyberpunk city"
 *
 * Environment variables:
 *   PI_LOCAL_IMAGE_BASE_URL  - API base URL (default: http://127.0.0.1:8045/v1)
 *   PI_LOCAL_IMAGE_API_KEY   - API key
 *   PI_LOCAL_IMAGE_MODEL     - Model name (default: gemini-3-pro-image)
 *   PI_IMAGE_SAVE_MODE       - Save mode: none|project|global|custom (default: none)
 *   PI_IMAGE_SAVE_DIR        - Directory for custom save mode
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_BASE_URL = "http://127.0.0.1:8045/v1";
const DEFAULT_API_KEY = "sk-4da0a298433a4b788fe409d5124791c8";
const DEFAULT_MODEL = "gemini-3-pro-image";

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const SIZES = ["1024x1024", "512x512", "768x768", "1024x768", "768x1024", "1536x1024", "1024x1536"] as const;

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image description." }),
	model: Type.Optional(
		Type.String({
			description: `Model id. Default: ${DEFAULT_MODEL}`,
		}),
	),
	size: Type.Optional(
		StringEnum(SIZES, {
			description: "Image size. Default: 1024x1024",
		}),
	),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save image when save=custom.",
		}),
	),
});

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

function resolveSaveConfig(params: { save?: SaveMode; saveDir?: string }, cwd: string): SaveConfig {
	const envMode = (process.env.PI_IMAGE_SAVE_MODE || "").toLowerCase();
	const mode = (params.save || envMode || "none") as SaveMode;

	if (mode === "project") return { mode, outputDir: join(cwd, ".pi", "generated-images") };
	if (mode === "global") return { mode, outputDir: join(homedir(), ".pi", "agent", "generated-images") };
	if (mode === "custom") {
		const dir = params.saveDir || process.env.PI_IMAGE_SAVE_DIR;
		if (!dir?.trim()) throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
		return { mode, outputDir: dir };
	}
	return { mode };
}

function imageExtension(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("gif")) return "gif";
	if (lower.includes("webp")) return "webp";
	return "png";
}

async function saveImage(base64Data: string, mimeType: string, outputDir: string): Promise<string> {
	await mkdir(outputDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = imageExtension(mimeType);
	const filename = `image-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
	const filePath = join(outputDir, filename);
	await writeFile(filePath, Buffer.from(base64Data, "base64"));
	return filePath;
}

/** Extract base64 image data from a data URI or raw base64 string */
function parseImageData(url: string): { data: string; mimeType: string } | undefined {
	// data:image/png;base64,iVBOR...
	const dataUriMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
	if (dataUriMatch) {
		return { mimeType: dataUriMatch[1], data: dataUriMatch[2] };
	}
	return undefined;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
			reasoning_content?: string;
		};
	}>;
}

/** Detect image MIME type from base64-encoded magic bytes */
function detectImageMime(base64: string): string {
	const header = base64.slice(0, 16);
	if (header.startsWith("/9j/")) return "image/jpeg";
	if (header.startsWith("iVBOR")) return "image/png";
	if (header.startsWith("R0lGO")) return "image/gif";
	if (header.startsWith("UklGR")) return "image/webp";
	return "image/jpeg"; // default fallback
}

/** Check if a string looks like raw base64 image data (no data URI prefix) */
function isRawBase64Image(str: string): boolean {
	// Must be long enough to be an image and contain only base64 chars
	if (str.length < 100) return false;
	if (/\s/.test(str.slice(0, 100))) return false;
	if (!/^[A-Za-z0-9+/]/.test(str)) return false;
	// Check magic bytes for known image formats
	const header = str.slice(0, 16);
	return header.startsWith("/9j/") || header.startsWith("iVBOR") || header.startsWith("R0lGO") || header.startsWith("UklGR");
}

export default function localImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description:
			"Generate an image via a local OpenAI-compatible API. Returns the image inline. " +
			"Optional saving via save=project|global|custom|none.",
		parameters: TOOL_PARAMS,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const baseUrl = process.env.PI_LOCAL_IMAGE_BASE_URL || DEFAULT_BASE_URL;
			const apiKey = process.env.PI_LOCAL_IMAGE_API_KEY || DEFAULT_API_KEY;
			const model = params.model || process.env.PI_LOCAL_IMAGE_MODEL || DEFAULT_MODEL;

			onUpdate?.({
				content: [{ type: "text", text: `Requesting image from ${model}...` }],
				details: { model },
			});

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages: [
						{
							role: "user",
							content: params.prompt,
						},
					],
					size: params.size || "1024x1024",
				}),
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Image request failed (${response.status}): ${errorText}`);
			}

			const result = (await response.json()) as ChatCompletionResponse;
			const message = result.choices?.[0]?.message;
			if (!message) {
				throw new Error("No response from model");
			}

			// Extract image and text from response
			let imageData: { data: string; mimeType: string } | undefined;
			const textParts: string[] = [];

			// Capture reasoning content if present
			if (message.reasoning_content) {
				// Skip reasoning content — it's internal model thinking
			}

			if (typeof message.content === "string") {
				// Check for data URI format: data:image/png;base64,...
				const b64Match = message.content.match(/data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)/);
				if (b64Match) {
					imageData = { mimeType: b64Match[1], data: b64Match[2] };
					textParts.push(message.content.replace(/!\[.*?\]\(data:image\/[^)]+\)/, "").trim());
				} else if (isRawBase64Image(message.content)) {
					// Raw base64 string (no data URI prefix) — detect MIME from magic bytes
					const mimeType = detectImageMime(message.content);
					imageData = { data: message.content, mimeType };
				} else {
					textParts.push(message.content);
				}
			} else if (Array.isArray(message.content)) {
				// Multimodal response with content parts
				for (const part of message.content) {
					if (part.type === "text" && part.text) {
						textParts.push(part.text);
					} else if (part.type === "image_url" && part.image_url?.url) {
						const parsed = parseImageData(part.image_url.url);
						if (parsed) {
							imageData = parsed;
						}
					}
				}
			}

			if (!imageData) {
				// No image found — return text response
				return {
					content: [
						{
							type: "text" as const,
							text: `Model did not return an image. Response: ${textParts.join("\n") || "(empty)"}`,
						},
					],
					details: { model, error: "no image in response" },
				};
			}

			// Save if configured
			const saveConfig = resolveSaveConfig(params, ctx.cwd);
			let savedPath: string | undefined;
			let saveError: string | undefined;
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				try {
					savedPath = await saveImage(imageData.data, imageData.mimeType, saveConfig.outputDir);
				} catch (error) {
					saveError = error instanceof Error ? error.message : String(error);
				}
			}

			const summaryParts = [`Generated image via ${model}.`];
			if (savedPath) summaryParts.push(`Saved to: ${savedPath}`);
			else if (saveError) summaryParts.push(`Failed to save: ${saveError}`);
			if (textParts.length > 0 && textParts.some((t) => t.length > 0)) {
				summaryParts.push(`Model notes: ${textParts.join(" ")}`);
			}

			return {
				content: [
					{ type: "text" as const, text: summaryParts.join(" ") },
					{ type: "image" as const, data: imageData.data, mimeType: imageData.mimeType },
				],
				details: { model, savedPath, saveMode: saveConfig.mode },
			};
		},
	});
}
