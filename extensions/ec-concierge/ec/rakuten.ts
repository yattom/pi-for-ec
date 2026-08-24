/**
 * 楽天市場 商品検索API (Rakuten Ichiba Item Search)。
 * アプリID（無料）を取得して config.ec.rakuten.applicationId に設定すると使える。
 * https://webservice.rakuten.co.jp/documentation/ichiba-item-search
 */

import type { EcConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import { stripTrackingParams } from "../util.ts";
import type { Product, ProductSearchQuery } from "./types.ts";

interface RakutenItem {
	itemName?: string;
	itemCode?: string;
	itemPrice?: number | string;
	itemUrl?: string;
	affiliateUrl?: string;
	shopName?: string;
	reviewAverage?: number | string;
	reviewCount?: number | string;
	postageFlag?: number;
	availability?: number;
	mediumImageUrls?: Array<string | { imageUrl?: string }>;
	itemCaption?: string;
}

/** formatVersion=1 (Items[].Item) と formatVersion=2 (Items[]) の両方を受け付ける。 */
export function parseRakutenResponse(payload: unknown): Product[] {
	const items = (payload as { Items?: unknown })?.Items;
	if (!Array.isArray(items)) return [];
	const products: Product[] = [];
	for (const entry of items) {
		const item: RakutenItem | undefined =
			entry && typeof entry === "object" && "Item" in (entry as Record<string, unknown>)
				? ((entry as { Item?: RakutenItem }).Item ?? undefined)
				: (entry as RakutenItem);
		if (!item?.itemUrl) continue;
		const image = item.mediumImageUrls?.[0];
		products.push({
			id: `rakuten:${item.itemCode ?? item.itemUrl}`,
			source: "rakuten",
			sourceName: "楽天市場",
			title: item.itemName ?? "(名称不明)",
			url: stripTrackingParams(item.affiliateUrl || item.itemUrl),
			price: toNumber(item.itemPrice),
			shipping: item.postageFlag === 0 ? "送料込み" : item.postageFlag === 1 ? "送料別" : undefined,
			shop: item.shopName,
			reviewAverage: toNumber(item.reviewAverage),
			reviewCount: toNumber(item.reviewCount),
			imageUrl: typeof image === "string" ? image : image?.imageUrl,
			availability: item.availability === 0 ? "在庫なし" : item.availability === 1 ? "在庫あり" : undefined,
			snippet: item.itemCaption?.slice(0, 300),
		});
	}
	return products;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") {
		const parsed = Number(value.replace(/,/g, ""));
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

const SORT_MAP: Record<NonNullable<ProductSearchQuery["sort"]>, string> = {
	"price-asc": "+itemPrice",
	"price-desc": "-itemPrice",
	review: "-reviewCount",
	relevance: "standard",
};

export function buildRakutenUrl(
	query: ProductSearchQuery,
	config: EcConfig["rakuten"],
	applicationId: string,
	affiliateId?: string,
): string {
	const url = new URL(config.endpoint);
	url.searchParams.set("applicationId", applicationId);
	url.searchParams.set("formatVersion", "2");
	url.searchParams.set("keyword", query.keyword);
	url.searchParams.set("hits", String(Math.min(Math.max(query.limit ?? 10, 1), 30)));
	url.searchParams.set("sort", SORT_MAP[query.sort ?? "relevance"]);
	url.searchParams.set("imageFlag", "1");
	if (query.minPrice !== undefined) url.searchParams.set("minPrice", String(Math.floor(query.minPrice)));
	if (query.maxPrice !== undefined) url.searchParams.set("maxPrice", String(Math.floor(query.maxPrice)));
	if (affiliateId) url.searchParams.set("affiliateId", affiliateId);
	return url.toString();
}

export async function searchRakuten(
	query: ProductSearchQuery,
	deps: {
		http: HttpClient;
		config: EcConfig["rakuten"];
		applicationId: string;
		affiliateId?: string;
		signal?: AbortSignal;
	},
): Promise<Product[]> {
	const url = buildRakutenUrl(query, deps.config, deps.applicationId, deps.affiliateId);
	const payload = await deps.http.fetchJson(url, { signal: deps.signal });
	return parseRakutenResponse(payload);
}
