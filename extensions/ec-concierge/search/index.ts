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
	runBackend,
} from "./backends.ts";
import type { SearchQuery, SearchResult } from "./types.ts";

export type { SearchQuery, SearchResult } from "./types.ts";
export { buildQueryString } from "./types.ts";

export interface SearchOutcome {
	results: SearchResult[];
	/** 実際に結果を返したバックエンド */
	backend: BackendId;
	/** 失敗したバックエンドの記録（ユーザーに原因を伝えるため） */
	attempts: Array<{ backend: BackendId; error: string }>;
}

export class WebSearch {
	constructor(
		private readonly http: HttpClient,
		private readonly getConfig: () => SearchConfig,
		private readonly resolve: (value: string | undefined) => Promise<string | undefined>,
	) {}

	async availability(): Promise<Record<BackendId, boolean>> {
		const config = this.getConfig();
		return backendAvailability({ http: this.http, config, resolve: this.resolve });
	}

	async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchOutcome> {
		const config = this.getConfig();
		const deps: BackendDeps = { http: this.http, config, resolve: this.resolve, signal };
		const availability = await backendAvailability(deps);
		const candidates = backendCandidates(config.backend, availability);
		if (candidates.length === 0) {
			throw new Error(
				"利用できる検索バックエンドがありません。BRAVE_SEARCH_API_KEY などを設定するか、search.backend を指定してください。",
			);
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
		throw new Error(`Web検索に失敗しました (${detail})`);
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
