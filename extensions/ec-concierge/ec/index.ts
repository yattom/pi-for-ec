/**
 * 複数ECサイトを横断した商品検索。
 * 公式API（楽天・Yahoo!）が使えるならそれを、無ければサイト指定のWeb検索を使う。
 */

import type { EcConfig, EcSiteConfig } from "../config.ts";
import type { HttpClient } from "../http.ts";
import type { WebSearch } from "../search/index.ts";
import { dedupeBy, formatJpy } from "../util.ts";
import { searchRakuten } from "./rakuten.ts";
import type { Product, ProductSearchOutcome, ProductSearchQuery } from "./types.ts";
import { buildSiteSearchQuery, searchResultToProduct } from "./web.ts";
import { searchYahoo } from "./yahoo.ts";

export type { Product, ProductSearchOutcome, ProductSearchQuery } from "./types.ts";

export class EcSearchService {
	constructor(
		private readonly http: HttpClient,
		private readonly webSearch: WebSearch,
		private readonly getConfig: () => EcConfig,
		private readonly resolve: (value: string | undefined) => Promise<string | undefined>,
	) {}

	/** 指定できるソースID一覧（"rakuten" / "yahoo" / webSites の id）。 */
	availableSourceIds(): string[] {
		const config = this.getConfig();
		return ["rakuten", "yahoo", ...config.webSites.map((site) => site.id)];
	}

	findWebSite(id: string): EcSiteConfig | undefined {
		return this.getConfig().webSites.find((site) => site.id === id);
	}

	async search(
		query: ProductSearchQuery,
		options: { sources?: string[]; signal?: AbortSignal } = {},
	): Promise<ProductSearchOutcome> {
		const config = this.getConfig();
		const requested = options.sources?.length ? options.sources : config.defaultSites;
		const products: Product[] = [];
		const errors: ProductSearchOutcome["errors"] = [];
		const used: string[] = [];

		for (const source of requested) {
			try {
				if (source === "rakuten") {
					if (!config.rakuten.enabled) throw new Error("設定で無効化されています");
					const applicationId = await this.resolve(config.rakuten.applicationId);
					if (!applicationId) throw new Error("楽天アプリID（applicationId）が未設定です");
					const affiliateId = await this.resolve(config.rakuten.affiliateId);
					products.push(
						...(await searchRakuten(query, {
							http: this.http,
							config: config.rakuten,
							applicationId,
							affiliateId,
							signal: options.signal,
						})),
					);
					used.push(source);
					continue;
				}

				if (source === "yahoo") {
					if (!config.yahoo.enabled) throw new Error("設定で無効化されています");
					const appId = await this.resolve(config.yahoo.appId);
					if (!appId) throw new Error("Yahoo!アプリケーションID（appId）が未設定です");
					products.push(
						...(await searchYahoo(query, { http: this.http, config: config.yahoo, appId, signal: options.signal })),
					);
					used.push(source);
					continue;
				}

				const site = this.findWebSite(source);
				if (!site) throw new Error(`未知のソースです（利用可能: ${this.availableSourceIds().join(", ")}）`);
				const outcome = await this.webSearch.search(
					{
						query: buildSiteSearchQuery(query, site),
						sites: [site.domain],
						count: query.limit ?? 8,
						lang: "ja",
					},
					options.signal,
				);
				products.push(...outcome.results.map((result) => searchResultToProduct(result, site)));
				used.push(source);
			} catch (error) {
				errors.push({ source, message: error instanceof Error ? error.message : String(error) });
			}
		}

		const filtered = products.filter((product) => {
			if (query.minPrice !== undefined && product.price !== undefined && product.price < query.minPrice) return false;
			if (query.maxPrice !== undefined && product.price !== undefined && product.price > query.maxPrice) return false;
			return true;
		});

		return { products: dedupeBy(filtered, (product) => product.url), errors, sources: used };
	}
}

/** 商品リストを LLM 向けテキストに整形する。 */
export function formatProducts(products: readonly Product[]): string {
	if (products.length === 0) return "(該当する商品が見つかりませんでした)";
	return products
		.map((product, index) => {
			const review =
				product.reviewAverage !== undefined
					? `★${product.reviewAverage.toFixed(1)}（${product.reviewCount ?? 0}件）`
					: "レビュー情報なし";
			const details = [
				`価格: ${formatJpy(product.price)}`,
				review,
				product.shop ? `店舗: ${product.shop}` : undefined,
				product.shipping,
				product.availability,
			]
				.filter(Boolean)
				.join(" / ");
			const snippet = product.snippet ? `\n   概要: ${product.snippet}` : "";
			return `${index + 1}. [${product.sourceName}] ${product.title}\n   ${details}\n   URL: ${product.url}${snippet}`;
		})
		.join("\n");
}
