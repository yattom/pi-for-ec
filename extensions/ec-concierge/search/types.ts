/** Web検索の共通型。 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** どのバックエンドから得たか（brave / google-cse / searxng / duckduckgo） */
	backend: string;
	/** 検索エンジンが返した公開日など（あれば） */
	published?: string;
}

export interface SearchQuery {
	query: string;
	/** 上限件数 */
	count?: number;
	/** site: 制約に使うドメイン */
	sites?: string[];
	/** 言語ヒント。"ja" で日本語優先、"any" で制約なし */
	lang?: "ja" | "any";
}

/** サイト制約付きのクエリ文字列を組み立てる。 */
export function buildQueryString(query: SearchQuery): string {
	const sites = (query.sites ?? []).filter((site) => site.trim().length > 0);
	if (sites.length === 0) return query.query;
	if (sites.length === 1) return `${query.query} site:${sites[0]}`;
	return `${query.query} (${sites.map((site) => `site:${site}`).join(" OR ")})`;
}
