/**
 * HTTP クライアント。
 *
 * 重要な設計方針:
 *  - Web検索・ページ取得はすべて「pi を動かしているマシン」から発行する。
 *    LLM 側（Anthropic API や LAN 内の llama.cpp）にはテキスト化した結果だけを渡し、
 *    プロバイダ内蔵の Web 検索ツールは使わない。
 *  - 相手サイトに迷惑をかけないよう、ホスト単位のレート制限と robots.txt 尊重を既定で有効にする。
 */

import type { HttpConfig } from "./config.ts";
import { htmlToText, truncate } from "./util.ts";

export interface FetchTextResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	/** text/html の場合は本文をテキスト化したもの */
	text: string;
	rawLength: number;
	truncated: boolean;
	html?: string;
}

export interface RobotsRule {
	type: "allow" | "disallow";
	path: string;
}

/**
 * robots.txt を、指定 User-agent に適用されるルール列へパースする。
 * より具体的な（= User-agent 名が一致する）グループがあればそれを優先し、
 * なければ `*` グループを使う。
 */
export function parseRobots(text: string, userAgentToken: string): RobotsRule[] {
	const token = userAgentToken.toLowerCase();
	const groups = new Map<string, RobotsRule[]>();
	let currentAgents: string[] = [];
	let lastLineWasAgent = false;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const field = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();

		if (field === "user-agent") {
			if (!lastLineWasAgent) currentAgents = [];
			currentAgents.push(value.toLowerCase());
			for (const agent of currentAgents) if (!groups.has(agent)) groups.set(agent, []);
			lastLineWasAgent = true;
			continue;
		}
		lastLineWasAgent = false;
		if (field !== "allow" && field !== "disallow") continue;
		if (currentAgents.length === 0) continue;
		for (const agent of currentAgents) {
			groups.get(agent)?.push({ type: field, path: value });
		}
	}

	for (const [agent, rules] of groups) {
		if (agent !== "*" && token.includes(agent)) return rules;
	}
	return groups.get("*") ?? [];
}

function robotsPatternMatches(pattern: string, path: string): number {
	if (pattern === "") return -1;
	const mustEnd = pattern.endsWith("$");
	const body = mustEnd ? pattern.slice(0, -1) : pattern;
	const segments = body.split("*");
	let index = 0;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (segment === "") continue;
		const found = i === 0 ? (path.startsWith(segment) ? 0 : -1) : path.indexOf(segment, index);
		if (found < 0) return -1;
		index = found + segment.length;
	}
	if (mustEnd && index !== path.length) return -1;
	return body.length;
}

/** robots.txt のルール列に対してパスが許可されているか判定する（最長一致優先）。 */
export function isPathAllowed(rules: readonly RobotsRule[], path: string): boolean {
	let best: { rule: RobotsRule; length: number } | undefined;
	for (const rule of rules) {
		const length = robotsPatternMatches(rule.path, path);
		if (length < 0) continue;
		if (!best || length > best.length || (length === best.length && rule.type === "allow")) {
			best = { rule, length };
		}
	}
	if (!best) return true;
	return best.rule.type === "allow";
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => Boolean(s));
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}

export class HttpError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly url?: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export class HttpClient {
	private lastRequestAt = new Map<string, number>();
	private hostQueues = new Map<string, Promise<unknown>>();
	private robotsCache = new Map<string, Promise<RobotsRule[]>>();

	constructor(private readonly config: HttpConfig) {}

	private get userAgentToken(): string {
		return this.config.userAgent.split("/")[0] ?? "pi-ec-concierge";
	}

	/** 同一ホストへのリクエストを直列化し、最小間隔を空ける。 */
	private schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
		const previous = this.hostQueues.get(host) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			const last = this.lastRequestAt.get(host) ?? 0;
			const wait = this.config.minIntervalMsPerHost - (Date.now() - last);
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			this.lastRequestAt.set(host, Date.now());
			return task();
		});
		this.hostQueues.set(
			host,
			next.catch(() => undefined),
		);
		return next;
	}

	async checkRobots(url: string, signal?: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
		if (!this.config.respectRobotsTxt) return { allowed: true };
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { allowed: false, reason: "URL の形式が不正です" };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { allowed: false, reason: `${parsed.protocol} は取得できません` };
		}
		const origin = parsed.origin;
		let rulesPromise = this.robotsCache.get(origin);
		if (!rulesPromise) {
			rulesPromise = this.fetchRobots(origin, signal);
			this.robotsCache.set(origin, rulesPromise);
		}
		const rules = await rulesPromise;
		const allowed = isPathAllowed(rules, `${parsed.pathname}${parsed.search}`);
		return allowed ? { allowed } : { allowed: false, reason: `${origin}/robots.txt により許可されていません` };
	}

	private async fetchRobots(origin: string, signal?: AbortSignal): Promise<RobotsRule[]> {
		try {
			const response = await this.rawFetch(`${origin}/robots.txt`, { signal });
			if (!response.ok) return [];
			const text = await response.text();
			return parseRobots(text, this.userAgentToken);
		} catch {
			return [];
		}
	}

	private rawFetch(url: string, options: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
		const host = new URL(url).host;
		return this.schedule(host, () =>
			fetch(url, {
				redirect: "follow",
				headers: {
					"user-agent": this.config.userAgent,
					"accept-language": "ja,en;q=0.8",
					...options.headers,
				},
				signal: combineSignals([options.signal, AbortSignal.timeout(this.config.timeoutMs)]),
			}),
		);
	}

	/** 上限バイト数まで読み込む。 */
	private async readCapped(response: Response): Promise<{ body: string; truncated: boolean; rawLength: number }> {
		const reader = response.body?.getReader();
		if (!reader) {
			const body = await response.text();
			return { body, truncated: false, rawLength: body.length };
		}
		const decoder = new TextDecoder("utf-8");
		let received = 0;
		let body = "";
		let truncated = false;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > this.config.maxBytes) {
				body += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (received - this.config.maxBytes))));
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
			body += decoder.decode(value, { stream: true });
		}
		if (!truncated) body += decoder.decode();
		return { body, truncated, rawLength: received };
	}

	/** ページを取得してテキスト化する。robots.txt で拒否されている場合は例外。 */
	async fetchText(
		url: string,
		options: { signal?: AbortSignal; maxChars?: number; headers?: Record<string, string> } = {},
	): Promise<FetchTextResult> {
		const robots = await this.checkRobots(url, options.signal);
		if (!robots.allowed) throw new HttpError(robots.reason ?? "robots.txt により取得できません", undefined, url);

		const response = await this.rawFetch(url, { signal: options.signal, headers: options.headers });
		if (!response.ok) throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, url);

		const contentType = response.headers.get("content-type") ?? "";
		const { body, truncated, rawLength } = await this.readCapped(response);
		const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
		const text = isHtml ? htmlToText(body) : body;
		return {
			url,
			finalUrl: response.url || url,
			status: response.status,
			contentType,
			text: options.maxChars ? truncate(text, options.maxChars) : text,
			rawLength,
			truncated,
			html: isHtml ? body : undefined,
		};
	}

	/** JSON API 用。robots.txt チェックは行わない（公式APIエンドポイント向け）。 */
	async fetchJson<T = unknown>(
		url: string,
		options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
	): Promise<T> {
		const response = await this.rawFetch(url, {
			signal: options.signal,
			headers: { accept: "application/json", ...options.headers },
		});
		const text = await response.text();
		if (!response.ok) {
			const detail = text.slice(0, 300).replace(/\s+/g, " ");
			throw new HttpError(`HTTP ${response.status}: ${detail}`, response.status, url);
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new HttpError(`JSON として解釈できない応答: ${text.slice(0, 200)}`, response.status, url);
		}
	}

	/** POST フォーム（DuckDuckGo HTML など）。 */
	async postForm(
		url: string,
		form: Record<string, string>,
		options: { signal?: AbortSignal } = {},
	): Promise<{ status: number; body: string }> {
		const host = new URL(url).host;
		const response = await this.schedule(host, () =>
			fetch(url, {
				method: "POST",
				headers: {
					"user-agent": this.config.userAgent,
					"content-type": "application/x-www-form-urlencoded",
					"accept-language": "ja,en;q=0.8",
				},
				body: new URLSearchParams(form).toString(),
				signal: combineSignals([options.signal, AbortSignal.timeout(this.config.timeoutMs)]),
			}),
		);
		const { body } = await this.readCapped(response);
		return { status: response.status, body };
	}
}
