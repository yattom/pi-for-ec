/**
 * 公式APIを持たない（あるいは利用条件が厳しい）ECサイト向けのフォールバック。
 * サイトを絞った Web検索の結果を商品候補として扱い、価格はスニペットから推定する。
 * 価格が取れない場合でも URL は返すので、必要なら web_fetch で個別ページを確認できる。
 */

import type { EcSiteConfig } from "../config.ts";
import type { SearchResult } from "../search/index.ts";
import { parseJpPrice } from "../util.ts";
import type { Product, ProductSearchQuery } from "./types.ts";

/** 検索結果1件を商品候補に変換する。 */
export function searchResultToProduct(result: SearchResult, site: EcSiteConfig): Product {
	const priceText = `${result.title} ${result.snippet}`;
	return {
		id: `web:${site.id}:${result.url}`,
		source: `web:${site.id}`,
		sourceName: site.name,
		title: result.title,
		url: result.url,
		price: parseJpPrice(priceText),
		snippet: result.snippet.replace(/\s+/g, " ").slice(0, 300),
	};
}

/** サイト内検索用のクエリ文字列を作る。 */
export function buildSiteSearchQuery(query: ProductSearchQuery, site: EcSiteConfig): string {
	const parts = [query.keyword];
	if (site.queryHint) parts.push(site.queryHint);
	if (query.maxPrice !== undefined) parts.push(`${Math.floor(query.maxPrice)}円以下`);
	return parts.join(" ");
}
