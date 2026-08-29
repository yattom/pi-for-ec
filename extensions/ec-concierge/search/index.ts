/**
 * Web検索のオーケストレーション。
 * 設定されたバックエンドを順に試し、最初に成功したものの結果を返す。
 */

import type { SearchConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import { dedupeBy, hostnameOf } from "../util.ts";
import {
	type BackendDeps,
	type BackendId,
	backendAvailability,
	backendCandidates,
	hasConfiguredBackend,
	resolveSearxngInstances,
	runBackend,
	searxngSearchOne,
} from "./backends.ts";
import { createSearxngPoolState, type SearxngPoolState } from "./searxng-pool.ts";
import type { SearchQuery, SearchResult } from "./types.ts";

export type { SearchQuery, SearchResult } from "./types.ts";
export { buildQueryString } from "./types.ts";

export const SEARCH_FAILED_PREFIX = "Web検索に失敗しました（";

/**
 * 検索が全滅したときに出す案内。
 * 「キーを設定していないと何も調べられない」状態に気づけるようにする。
 */
export function searchSetupHint(availability: Record<BackendId, boolean>): string {
	if (hasConfiguredBackend(availability)) {
		return "設定済みの検索バックエンドが応答しませんでした。ネットワークとAPIキーの残量を確認してください（/ec-search-test で個別に試せます）。";
	}
	return [
		"検索APIキーが未設定のため、キー不要の経路（Tavilyキーレス / DuckDuckGo）だけで動いています。これらは制限が厳しく、失敗しやすい経路です。",
		"次のいずれかを設定してください（詳細は docs/data-sources.md）:",
		"  - TAVILY_API_KEY … 無料枠あり・カード不要。最も手軽",
		"  - SERPER_API_KEY … Google の検索結果。無料枠あり",
		"  - BRAVE_SEARCH_API_KEY … 品質は高いがカード登録が必要",
		"  - SEARXNG_BASE_URL / search.searxng.instances … SearXNG。複数インスタンスを登録すればローテーションする",
	].join("\n");
}

export interface SearchOutcome {
	results: SearchResult[];
	/** 実際に結果を返したバックエンド */
	backend: BackendId;
	/** 失敗したバックエンドの記録（ユーザーに原因を伝えるため） */
	attempts: Array<{ backend: BackendId; error: string }>;
}

export class WebSearch {
	/** SearXNG の複数インスタンスをローテーションする状態。セッションを通じて持ち回す。 */
	private readonly searxngPool: SearxngPoolState = createSearxngPoolState();

	constructor(
		private readonly http: HttpClient,
		private readonly getConfig: () => SearchConfig,
		private readonly resolve: (value: string | undefined) => Promise<string | undefined>,
	) {}

	async availability(): Promise<Record<BackendId, boolean>> {
		const config = this.getConfig();
		return backendAvailability({ http: this.http, config, resolve: this.resolve });
	}

	/** 指定したバックエンドだけを実行する（フォールバックしない）。/ec-search-test 用。 */
	async searchWith(backend: BackendId, query: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
		const config = this.getConfig();
		return runBackend(backend, query, { http: this.http, config, resolve: this.resolve, signal, searxngPool: this.searxngPool });
	}

	/**
	 * 設定されている SearXNG インスタンスを1つずつ（ローテーションを介さず）直接叩き、
	 * どれが実際に応答するかを調べる。/ec-search-test の内訳表示用。
	 */
	async testSearxngInstances(
		query: SearchQuery,
		signal?: AbortSignal,
	): Promise<Array<{ url: string; ok: boolean; count: number; elapsedMs: number; error?: string }>> {
		const config = this.getConfig();
		const urls = await resolveSearxngInstances(config.searxng, this.resolve);
		const deps: BackendDeps = { http: this.http, config, resolve: this.resolve, signal };
		const results: Array<{ url: string; ok: boolean; count: number; elapsedMs: number; error?: string }> = [];
		for (const url of urls) {
			const startedAt = Date.now();
			try {
				const items = await searxngSearchOne(url, query, deps);
				results.push({ url, ok: items.length > 0, count: items.length, elapsedMs: Date.now() - startedAt });
			} catch (error) {
				results.push({
					url,
					ok: false,
					count: 0,
					elapsedMs: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchOutcome> {
		const config = this.getConfig();
		const deps: BackendDeps = { http: this.http, config, resolve: this.resolve, signal, searxngPool: this.searxngPool };
		const availability = await backendAvailability(deps);
		const candidates = backendCandidates(config.backend, availability);
		if (candidates.length === 0) {
			throw new Error(`利用できる検索バックエンドがありません。\n${searchSetupHint(availability)}`);
		}

		const attempts: SearchOutcome["attempts"] = [];
		for (const backend of candidates) {
			try {
				const results = await runBackend(backend, query, deps);
				if (results.length === 0) {
					attempts.push({ backend, error: "結果が0件でした" });
					continue;
				}
				return {
					results: dedupeBy(results, (result) => result.url).slice(0, query.count ?? config.maxResults),
					backend,
					attempts,
				};
			} catch (error) {
				attempts.push({ backend, error: error instanceof Error ? error.message : String(error) });
			}
		}

		const detail = attempts.map((attempt) => `${attempt.backend}: ${attempt.error}`).join(" / ");
		throw new Error(`${SEARCH_FAILED_PREFIX}${detail}）\n${searchSetupHint(availability)}`);
	}

	/** 複数クエリをまとめて投げ、URL 重複を除いて返す。 */
	async searchMany(queries: SearchQuery[], signal?: AbortSignal): Promise<{ results: SearchResult[]; errors: string[] }> {
		const results: SearchResult[] = [];
		const errors: string[] = [];
		for (const query of queries) {
			try {
				const outcome = await this.search(query, signal);
				results.push(...outcome.results);
			} catch (error) {
				errors.push(`${query.query}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { results: dedupeBy(results, (result) => result.url), errors };
	}
}

/** 検索結果を LLM に渡しやすいテキストへ整形する。 */
export function formatSearchResults(results: readonly SearchResult[]): string {
	if (results.length === 0) return "(検索結果なし)";
	return results
		.map((result, index) => {
			const host = hostnameOf(result.url);
			const snippet = result.snippet.replace(/\s+/g, " ").slice(0, 300);
			return `${index + 1}. ${result.title}\n   URL: ${result.url}\n   サイト: ${host}\n   概要: ${snippet}`;
		})
		.join("\n");
}
