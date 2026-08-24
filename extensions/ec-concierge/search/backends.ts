/**
 * Web検索バックエンド。
 *
 * すべて pi 実行マシンから HTTP を発行する。LLM プロバイダ側の検索ツールは使わない。
 * 優先度: Brave Search API > Google Programmable Search > 自前の SearXNG > DuckDuckGo(HTML)
 */

import type { SearchConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, htmlToText, stripTrackingParams } from "../util.ts";
import { buildQueryString, type SearchQuery, type SearchResult } from "./types.ts";

export interface BackendDeps {
	http: HttpClient;
	config: SearchConfig;
	/** 設定値（"$ENV" など）を解決する関数 */
	resolve: (value: string | undefined) => Promise<string | undefined>;
	signal?: AbortSignal;
}

/* ------------------------------------------------------------------ Brave */

interface BraveResponse {
	web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
}

export function parseBraveResponse(payload: unknown): SearchResult[] {
	const results = (payload as BraveResponse)?.web?.results;
	if (!Array.isArray(results)) return [];
	return results
		.filter((item) => typeof item?.url === "string")
		.map((item) => ({
			title: decodeHtmlEntities(htmlToText(item.title ?? "")) || item.url!,
			url: stripTrackingParams(item.url!),
			snippet: decodeHtmlEntities(htmlToText(item.description ?? "")),
			backend: "brave",
			published: item.age,
		}));
}

async function braveSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const apiKey = await deps.resolve(deps.config.brave.apiKey);
	if (!apiKey) throw new Error("Brave Search の API キーが未設定です");
	const url = new URL(deps.config.brave.endpoint);
	url.searchParams.set("q", buildQueryString(query));
	url.searchParams.set("count", String(Math.min(query.count ?? deps.config.maxResults, 20)));
	if (query.lang !== "any") {
		url.searchParams.set("country", deps.config.brave.country);
		url.searchParams.set("search_lang", deps.config.brave.searchLang);
		url.searchParams.set("ui_lang", deps.config.brave.uiLang);
	}
	const payload = await deps.http.fetchJson(url.toString(), {
		signal: deps.signal,
		headers: { "x-subscription-token": apiKey, accept: "application/json" },
	});
	return parseBraveResponse(payload);
}

/* ------------------------------------------------- Google Programmable Search */

interface GoogleCseResponse {
	items?: Array<{ title?: string; link?: string; snippet?: string }>;
}

export function parseGoogleCseResponse(payload: unknown): SearchResult[] {
	const items = (payload as GoogleCseResponse)?.items;
	if (!Array.isArray(items)) return [];
	return items
		.filter((item) => typeof item?.link === "string")
		.map((item) => ({
			title: decodeHtmlEntities(item.title ?? "") || item.link!,
			url: stripTrackingParams(item.link!),
			snippet: decodeHtmlEntities(item.snippet ?? ""),
			backend: "google-cse",
		}));
}

async function googleCseSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const apiKey = await deps.resolve(deps.config.googleCse.apiKey);
	const cx = await deps.resolve(deps.config.googleCse.cx);
	if (!apiKey || !cx) throw new Error("Google Programmable Search の API キー / 検索エンジンID が未設定です");
	const url = new URL(deps.config.googleCse.endpoint);
	url.searchParams.set("key", apiKey);
	url.searchParams.set("cx", cx);
	url.searchParams.set("q", buildQueryString(query));
	url.searchParams.set("num", String(Math.min(query.count ?? deps.config.maxResults, 10)));
	if (query.lang !== "any") {
		url.searchParams.set("lr", deps.config.googleCse.lr);
		url.searchParams.set("gl", deps.config.googleCse.gl);
	}
	const payload = await deps.http.fetchJson(url.toString(), { signal: deps.signal });
	return parseGoogleCseResponse(payload);
}

/* ---------------------------------------------------------------- SearXNG */

interface SearxngResponse {
	results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
}

export function parseSearxngResponse(payload: unknown): SearchResult[] {
	const results = (payload as SearxngResponse)?.results;
	if (!Array.isArray(results)) return [];
	return results
		.filter((item) => typeof item?.url === "string")
		.map((item) => ({
			title: item.title ?? item.url!,
			url: stripTrackingParams(item.url!),
			snippet: item.content ?? "",
			backend: "searxng",
			published: item.publishedDate,
		}));
}

async function searxngSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const baseUrl = await deps.resolve(deps.config.searxng.baseUrl);
	if (!baseUrl) throw new Error("SearXNG の baseUrl が未設定です");
	const url = new URL("/search", baseUrl);
	url.searchParams.set("q", buildQueryString(query));
	url.searchParams.set("format", "json");
	if (query.lang !== "any") url.searchParams.set("language", deps.config.searxng.language);
	if (deps.config.searxng.engines) url.searchParams.set("engines", deps.config.searxng.engines);
	const payload = await deps.http.fetchJson(url.toString(), { signal: deps.signal });
	return parseSearxngResponse(payload).slice(0, query.count ?? deps.config.maxResults);
}

/* ------------------------------------------------------------- DuckDuckGo */

/** DuckDuckGo の HTML 版レスポンスから結果を取り出す（API キー不要のフォールバック）。 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: string[] = [];
	let snippetMatch: RegExpExecArray | null;
	while ((snippetMatch = snippetPattern.exec(html))) {
		snippets.push(htmlToText(snippetMatch[1] ?? ""));
	}
	let match: RegExpExecArray | null;
	let index = 0;
	while ((match = linkPattern.exec(html))) {
		const href = decodeHtmlEntities(match[1] ?? "");
		const url = unwrapDuckDuckGoRedirect(href);
		if (!url) continue;
		results.push({
			title: htmlToText(match[2] ?? "") || url,
			url: stripTrackingParams(url),
			snippet: snippets[index] ?? "",
			backend: "duckduckgo",
		});
		index += 1;
	}
	return results;
}

/** //duckduckgo.com/l/?uddg=<encoded> 形式のリダイレクトURLを実URLへ戻す。 */
export function unwrapDuckDuckGoRedirect(href: string): string | undefined {
	if (!href) return undefined;
	const normalized = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(normalized, "https://duckduckgo.com");
		const target = url.searchParams.get("uddg");
		if (target) return target;
		if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

async function duckDuckGoSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const { status, body } = await deps.http.postForm(
		deps.config.duckduckgo.endpoint,
		{
			q: buildQueryString(query),
			kl: query.lang === "any" ? "wt-wt" : deps.config.duckduckgo.region,
		},
		{ signal: deps.signal },
	);
	if (status !== 200) throw new Error(`DuckDuckGo が HTTP ${status} を返しました`);
	return parseDuckDuckGoHtml(body).slice(0, query.count ?? deps.config.maxResults);
}

/* ------------------------------------------------------------- ディスパッチ */

export type BackendId = "brave" | "google-cse" | "searxng" | "duckduckgo";

export const BACKEND_ORDER: BackendId[] = ["brave", "google-cse", "searxng", "duckduckgo"];

const BACKENDS: Record<BackendId, (query: SearchQuery, deps: BackendDeps) => Promise<SearchResult[]>> = {
	brave: braveSearch,
	"google-cse": googleCseSearch,
	searxng: searxngSearch,
	duckduckgo: duckDuckGoSearch,
};

/** 各バックエンドが使える状態か（資格情報が揃っているか）を調べる。 */
export async function backendAvailability(deps: BackendDeps): Promise<Record<BackendId, boolean>> {
	const [braveKey, googleKey, googleCx, searxngUrl] = await Promise.all([
		deps.resolve(deps.config.brave.apiKey),
		deps.resolve(deps.config.googleCse.apiKey),
		deps.resolve(deps.config.googleCse.cx),
		deps.resolve(deps.config.searxng.baseUrl),
	]);
	return {
		brave: Boolean(braveKey),
		"google-cse": Boolean(googleKey && googleCx),
		searxng: Boolean(searxngUrl),
		duckduckgo: true, // キー不要。ただしベストエフォート
	};
}

/** 実際に使うバックエンドの順序を決める。 */
export function backendCandidates(configured: SearchConfig["backend"], availability: Record<BackendId, boolean>): BackendId[] {
	if (configured !== "auto") return [configured];
	return BACKEND_ORDER.filter((id) => availability[id]);
}

export function runBackend(id: BackendId, query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	return BACKENDS[id](query, deps);
}
