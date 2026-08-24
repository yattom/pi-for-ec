/**
 * Yahoo!ショッピング 商品検索API (V3 itemSearch)。
 * Yahoo! JAPAN デベロッパーのアプリケーションIDを config.ec.yahoo.appId に設定すると使える。
 * https://developer.yahoo.co.jp/webapi/shopping/shopping/v3/itemsearch.html
 */

import type { EcConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import { stripTrackingParams } from "../util.ts";
import type { Product, ProductSearchQuery } from "./types.ts";

interface YahooHit {
	name?: string;
	description?: string;
	headLine?: string;
	url?: string;
	code?: string;
	price?: number;
	inStock?: boolean;
	review?: { rate?: number; count?: number };
	image?: { small?: string; medium?: string };
	seller?: { name?: string; sellerId?: string };
	shipping?: { name?: string; code?: number };
}

export function parseYahooResponse(payload: unknown): Product[] {
	const hits = (payload as { hits?: unknown })?.hits;
	if (!Array.isArray(hits)) return [];
	const products: Product[] = [];
	for (const hit of hits as YahooHit[]) {
		if (!hit?.url) continue;
		products.push({
			id: `yahoo:${hit.code ?? hit.url}`,
			source: "yahoo",
			sourceName: "Yahoo!ショッピング",
			title: hit.name ?? "(名称不明)",
			url: stripTrackingParams(hit.url),
			price: typeof hit.price === "number" ? hit.price : undefined,
			shipping: hit.shipping?.name,
			shop: hit.seller?.name,
			reviewAverage: hit.review?.rate,
			reviewCount: hit.review?.count,
			imageUrl: hit.image?.medium ?? hit.image?.small,
			availability: hit.inStock === undefined ? undefined : hit.inStock ? "在庫あり" : "在庫なし",
			snippet: (hit.headLine || hit.description)?.slice(0, 300),
		});
	}
	return products;
}

const SORT_MAP: Record<NonNullable<ProductSearchQuery["sort"]>, string> = {
	"price-asc": "+price",
	"price-desc": "-price",
	review: "-review_count",
	relevance: "-score",
};

export function buildYahooUrl(query: ProductSearchQuery, config: EcConfig["yahoo"], appId: string): string {
	const url = new URL(config.endpoint);
	url.searchParams.set("appid", appId);
	url.searchParams.set("query", query.keyword);
	url.searchParams.set("results", String(Math.min(Math.max(query.limit ?? 10, 1), 20)));
	url.searchParams.set("sort", SORT_MAP[query.sort ?? "relevance"]);
	if (query.minPrice !== undefined) url.searchParams.set("price_from", String(Math.floor(query.minPrice)));
	if (query.maxPrice !== undefined) url.searchParams.set("price_to", String(Math.floor(query.maxPrice)));
	return url.toString();
}

export async function searchYahoo(
	query: ProductSearchQuery,
	deps: { http: HttpClient; config: EcConfig["yahoo"]; appId: string; signal?: AbortSignal },
): Promise<Product[]> {
	const url = buildYahooUrl(query, deps.config, deps.appId);
	const payload = await deps.http.fetchJson(url, { signal: deps.signal });
	return parseYahooResponse(payload);
}
