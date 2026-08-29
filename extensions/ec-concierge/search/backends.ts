/**
 * Web検索バックエンド。
 *
 * すべて pi 実行マシンから HTTP を発行する。LLM プロバイダ側の検索ツールは使わない。
 * 優先度: Brave > Tavily > Serper > 自前の SearXNG > Google Programmable Search(廃止予定) > DuckDuckGo(HTML)
 * Tavily はキー無しでも「キーレスモード」で動くので、何も設定していないときの既定経路になる。
 */

import type { SearchConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, htmlToText, stripTrackingParams } from "../util.ts";
import { createSearxngPoolState, markFailure, markSuccess, pickInstance, type SearxngPoolState } from "./searxng-pool.ts";
import { buildQueryString, type SearchQuery, type SearchResult } from "./types.ts";

export interface BackendDeps {
	http: HttpClient;
	config: SearchConfig;
	/** 設定値（"$ENV" など）を解決する関数 */
	resolve: (value: string | undefined) => Promise<string | undefined>;
	signal?: AbortSignal;
	/** SearXNG の複数インスタンスをローテーションする状態。省略時はその呼び出し限りの使い捨てになる。 */
	searxngPool?: SearxngPoolState;
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

/* ----------------------------------------------------------------- Tavily */

interface TavilyResponse {
	results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
}

export function parseTavilyResponse(payload: unknown): SearchResult[] {
	const results = (payload as TavilyResponse)?.results;
	if (!Array.isArray(results)) return [];
	return results
		.filter((item) => typeof item?.url === "string")
		.map((item) => ({
			title: item.title ?? item.url!,
			url: stripTrackingParams(item.url!),
			snippet: (item.content ?? "").replace(/\s+/g, " "),
			backend: "tavily",
			published: item.published_date,
		}));
}

/**
 * Tavily の検索リクエストを組み立てる。
 * サイト制限は `site:` 演算子ではなく include_domains で渡せるので、絞り込みが正確になる。
 */
export function buildTavilyRequest(query: SearchQuery, config: SearchConfig): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: query.query,
		max_results: Math.min(query.count ?? config.maxResults, 20),
		search_depth: config.tavily.searchDepth,
		topic: "general",
	};
	if (query.sites?.length) body.include_domains = query.sites;
	if (query.lang !== "any" && config.tavily.country) body.country = config.tavily.country;
	return body;
}

async function tavilySearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const apiKey = await deps.resolve(deps.config.tavily.apiKey);
	// キーが無い場合は Tavily 公式の「キーレスモード」を使う（レート制限あり）
	const headers: Record<string, string> = apiKey
		? { authorization: `Bearer ${apiKey}` }
		: { "x-tavily-access-mode": "keyless", "x-client-source": "pi-ec-concierge-keyless" };
	const payload = await deps.http.postJson(deps.config.tavily.endpoint, buildTavilyRequest(query, deps.config), {
		signal: deps.signal,
		headers,
	});
	return parseTavilyResponse(payload);
}

/* ----------------------------------------------------------------- Serper */

interface SerperResponse {
	organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
}

export function parseSerperResponse(payload: unknown): SearchResult[] {
	const organic = (payload as SerperResponse)?.organic;
	if (!Array.isArray(organic)) return [];
	return organic
		.filter((item) => typeof item?.link === "string")
		.map((item) => ({
			title: item.title ?? item.link!,
			url: stripTrackingParams(item.link!),
			snippet: item.snippet ?? "",
			backend: "serper",
			published: item.date,
		}));
}

async function serperSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const apiKey = await deps.resolve(deps.config.serper.apiKey);
	if (!apiKey) throw new Error("Serper の API キーが未設定です");
	const body: Record<string, unknown> = {
		q: buildQueryString(query),
		num: Math.min(query.count ?? deps.config.maxResults, 20),
	};
	if (query.lang !== "any") {
		body.gl = deps.config.serper.gl;
		body.hl = deps.config.serper.hl;
	}
	const payload = await deps.http.postJson(deps.config.serper.endpoint, body, {
		signal: deps.signal,
		headers: { "x-api-key": apiKey },
	});
	return parseSerperResponse(payload);
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

/**
 * 設定に書かれた SearXNG インスタンスを解決してURL配列にする。
 * `instances`（複数）と後方互換の `baseUrl`（単一）の両方を対象にし、重複と末尾スラッシュを整える。
 */
export async function resolveSearxngInstances(
	config: SearchConfig["searxng"],
	resolve: (value: string | undefined) => Promise<string | undefined>,
): Promise<string[]> {
	const raw = [...(config.instances ?? [])];
	if (config.baseUrl) raw.push(config.baseUrl);
	const resolved = await Promise.all(raw.map((value) => resolve(value)));
	const normalized = resolved.filter((value): value is string => Boolean(value)).map((value) => value.replace(/\/+$/, ""));
	return [...new Set(normalized)];
}

/** 1つの SearXNG インスタンスに対して検索する。ローテーションの本体はこの関数の呼び出し側が担う。 */
export async function searxngSearchOne(baseUrl: string, query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const url = new URL("/search", baseUrl);
	url.searchParams.set("q", buildQueryString(query));
	url.searchParams.set("format", "json");
	if (query.lang !== "any") url.searchParams.set("language", deps.config.searxng.language);
	if (deps.config.searxng.engines) url.searchParams.set("engines", deps.config.searxng.engines);
	const payload = await deps.http.fetchJson(url.toString(), { signal: deps.signal });
	return parseSearxngResponse(payload).slice(0, query.count ?? deps.config.maxResults);
}

/**
 * 複数インスタンスをローテーションしながら検索する。
 * 公開インスタンスは JSON 出力（format=json）を無効化していることが多く、403 などで
 * 突然使えなくなりがちなので、失敗したインスタンスはクールダウンして次を試す。
 * すべて失敗したときだけエラーにする（内訳は個別のエラーメッセージとして残す）。
 */
async function searxngSearch(query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	const urls = await resolveSearxngInstances(deps.config.searxng, deps.resolve);
	if (urls.length === 0) throw new Error("SearXNG の baseUrl / instances が未設定です");

	const pool = deps.searxngPool ?? createSearxngPoolState();
	const errors: string[] = [];
	for (let attempt = 0; attempt < urls.length; attempt++) {
		const picked = pickInstance(urls, pool);
		if (!picked) break;
		try {
			const results = await searxngSearchOne(picked.url, query, deps);
			markSuccess(pool, picked.url);
			return results;
		} catch (error) {
			markFailure(pool, picked.url);
			errors.push(`${picked.url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`SearXNG インスタンスがすべて失敗しました (${errors.join(" / ")})`);
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

export type BackendId = "brave" | "tavily" | "serper" | "searxng" | "google-cse" | "duckduckgo";

/**
 * auto のときに試す順序。
 * キーが要るものを先に、キー無しでも動くもの（Tavily キーレス、DuckDuckGo）を後ろに置く。
 * Google Programmable Search は 2025年に新規受付を終了し 2027-01-01 に廃止されるため、
 * 既存ユーザー向けの互換目的で末尾寄りに残している。
 */
export const BACKEND_ORDER: BackendId[] = ["brave", "tavily", "serper", "searxng", "google-cse", "duckduckgo"];

const BACKENDS: Record<BackendId, (query: SearchQuery, deps: BackendDeps) => Promise<SearchResult[]>> = {
	brave: braveSearch,
	tavily: tavilySearch,
	serper: serperSearch,
	searxng: searxngSearch,
	"google-cse": googleCseSearch,
	duckduckgo: duckDuckGoSearch,
};

/** 各バックエンドが使える状態か（資格情報が揃っているか）を調べる。 */
export async function backendAvailability(deps: BackendDeps): Promise<Record<BackendId, boolean>> {
	const [braveKey, serperKey, googleKey, googleCx, searxngUrls] = await Promise.all([
		deps.resolve(deps.config.brave.apiKey),
		deps.resolve(deps.config.serper.apiKey),
		deps.resolve(deps.config.googleCse.apiKey),
		deps.resolve(deps.config.googleCse.cx),
		resolveSearxngInstances(deps.config.searxng, deps.resolve),
	]);
	return {
		brave: Boolean(braveKey),
		tavily: true, // キーが無くてもキーレスモードで動く（レート制限あり）
		serper: Boolean(serperKey),
		searxng: searxngUrls.length > 0,
		"google-cse": Boolean(googleKey && googleCx),
		duckduckgo: true, // キー不要。ただしスクレイピングでベストエフォート
	};
}

/** 資格情報を設定済みのバックエンド（キーレス頼みでないもの）があるか。 */
export function hasConfiguredBackend(availability: Record<BackendId, boolean>): boolean {
	return BACKEND_ORDER.some((id) => id !== "tavily" && id !== "duckduckgo" && availability[id]);
}

/** 実際に使うバックエンドの順序を決める。 */
export function backendCandidates(configured: SearchConfig["backend"], availability: Record<BackendId, boolean>): BackendId[] {
	if (configured !== "auto") return [configured];
	return BACKEND_ORDER.filter((id) => availability[id]);
}

export function runBackend(id: BackendId, query: SearchQuery, deps: BackendDeps): Promise<SearchResult[]> {
	return BACKENDS[id](query, deps);
}
