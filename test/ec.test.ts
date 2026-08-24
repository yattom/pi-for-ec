import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/ec-concierge/config.ts";
import { EcSearchService, formatProducts } from "../extensions/ec-concierge/ec/index.ts";
import { buildRakutenUrl, parseRakutenResponse } from "../extensions/ec-concierge/ec/rakuten.ts";
import { buildSiteSearchQuery, searchResultToProduct } from "../extensions/ec-concierge/ec/web.ts";
import { buildYahooUrl, parseYahooResponse } from "../extensions/ec-concierge/ec/yahoo.ts";
import { HttpClient } from "../extensions/ec-concierge/http.ts";
import { WebSearch } from "../extensions/ec-concierge/search/index.ts";

describe("楽天市場API", () => {
	const item = {
		itemName: "空気清浄機 KI-RX50",
		itemCode: "shop:10000",
		itemPrice: 39800,
		itemUrl: "https://item.rakuten.co.jp/shop/10000/?scid=af_link",
		shopName: "テスト家電",
		reviewAverage: "4.5",
		reviewCount: "128",
		postageFlag: 0,
		availability: 1,
		mediumImageUrls: ["https://thumbnail.image.rakuten.co.jp/x.jpg"],
		itemCaption: "説明文",
	};

	it("formatVersion=2（フラット）を解析する", () => {
		const products = parseRakutenResponse({ Items: [item] });
		expect(products).toHaveLength(1);
		expect(products[0]).toMatchObject({
			source: "rakuten",
			title: "空気清浄機 KI-RX50",
			price: 39800,
			shop: "テスト家電",
			reviewAverage: 4.5,
			reviewCount: 128,
			shipping: "送料込み",
			availability: "在庫あり",
		});
		// 追跡パラメータは落とす
		expect(products[0]?.url).toBe("https://item.rakuten.co.jp/shop/10000/");
	});

	it("formatVersion=1（Items[].Item）も解析する", () => {
		const products = parseRakutenResponse({ Items: [{ Item: item }] });
		expect(products[0]?.price).toBe(39800);
	});

	it("mediumImageUrls がオブジェクト配列でも読む", () => {
		const products = parseRakutenResponse({
			Items: [{ ...item, mediumImageUrls: [{ imageUrl: "https://img/1.jpg" }] }],
		});
		expect(products[0]?.imageUrl).toBe("https://img/1.jpg");
	});

	it("想定外の応答では空配列", () => {
		expect(parseRakutenResponse({ error: "wrong_parameter" })).toEqual([]);
		expect(parseRakutenResponse(null)).toEqual([]);
	});

	it("検索URLを組み立てる", () => {
		const url = new URL(
			buildRakutenUrl(
				{ keyword: "空気清浄機", minPrice: 10000, maxPrice: 50000, sort: "price-asc", limit: 40 },
				DEFAULT_CONFIG.ec.rakuten,
				"app-id",
				"affiliate-id",
			),
		);
		expect(url.searchParams.get("applicationId")).toBe("app-id");
		expect(url.searchParams.get("keyword")).toBe("空気清浄機");
		expect(url.searchParams.get("sort")).toBe("+itemPrice");
		expect(url.searchParams.get("minPrice")).toBe("10000");
		expect(url.searchParams.get("affiliateId")).toBe("affiliate-id");
		// hits は API 上限の 30 に丸める
		expect(url.searchParams.get("hits")).toBe("30");
	});
});

describe("Yahoo!ショッピングAPI", () => {
	it("hits を解析する", () => {
		const products = parseYahooResponse({
			hits: [
				{
					name: "空気清浄機",
					code: "store_item",
					url: "https://store.shopping.yahoo.co.jp/store/item.html",
					price: 42000,
					inStock: true,
					review: { rate: 4.2, count: 55 },
					image: { medium: "https://img/1.jpg" },
					seller: { name: "テストストア" },
					shipping: { name: "送料無料" },
					headLine: "ポイント10倍",
				},
			],
		});
		expect(products[0]).toMatchObject({
			source: "yahoo",
			price: 42000,
			reviewAverage: 4.2,
			shop: "テストストア",
			shipping: "送料無料",
			availability: "在庫あり",
		});
	});

	it("想定外の応答では空配列", () => {
		expect(parseYahooResponse({ Error: "invalid appid" })).toEqual([]);
	});

	it("検索URLを組み立てる", () => {
		const url = new URL(buildYahooUrl({ keyword: "椅子", sort: "review" }, DEFAULT_CONFIG.ec.yahoo, "app"));
		expect(url.searchParams.get("appid")).toBe("app");
		expect(url.searchParams.get("sort")).toBe("-review_count");
	});
});

describe("Web検索経由のEC", () => {
	const site = { id: "kakaku", name: "価格.com", domain: "kakaku.com" };

	it("検索結果から価格を推定して商品にする", () => {
		const product = searchResultToProduct(
			{
				title: "SHARP KI-RX50 最安値",
				url: "https://kakaku.com/item/K0001/",
				snippet: "最安価格 39,800円 のショップを比較",
				backend: "brave",
			},
			site,
		);
		expect(product).toMatchObject({ source: "web:kakaku", sourceName: "価格.com", price: 39800 });
	});

	it("価格上限をクエリに反映する", () => {
		expect(buildSiteSearchQuery({ keyword: "空気清浄機", maxPrice: 50000 }, site)).toBe("空気清浄機 50000円以下");
	});
});

describe("EcSearchService", () => {
	function makeService(handler: (url: string) => Response) {
		const http = new HttpClient({ ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => handler(String(input))),
		);
		const search = new WebSearch(
			http,
			() => DEFAULT_CONFIG.search,
			async () => undefined,
		);
		return new EcSearchService(
			http,
			search,
			() => DEFAULT_CONFIG.ec,
			async (value) => (value === "$RAKUTEN_APPLICATION_ID" ? "app-id" : undefined),
		);
	}

	it("使えないソースはエラーとして報告し、他のソースは続行する", async () => {
		const service = makeService((url) => {
			if (url.includes("rakuten")) {
				return new Response(
					JSON.stringify({
						Items: [
							{ itemName: "商品A", itemPrice: 3000, itemUrl: "https://item.rakuten.co.jp/a/", itemCode: "a" },
							{ itemName: "商品B", itemPrice: 99999, itemUrl: "https://item.rakuten.co.jp/b/", itemCode: "b" },
						],
					}),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 200 });
		});

		const outcome = await service.search(
			{ keyword: "テスト", maxPrice: 5000 },
			{ sources: ["rakuten", "yahoo", "unknown-source"] },
		);
		expect(outcome.sources).toEqual(["rakuten"]);
		// 価格上限で商品Bは除外される
		expect(outcome.products.map((product) => product.title)).toEqual(["商品A"]);
		expect(outcome.errors.map((error) => error.source)).toEqual(["yahoo", "unknown-source"]);
		expect(outcome.errors[0]?.message).toContain("appId");
		vi.unstubAllGlobals();
	});
});

describe("formatProducts", () => {
	it("価格・レビュー・URLを含む一覧にする", () => {
		const text = formatProducts([
			{
				id: "1",
				source: "rakuten",
				sourceName: "楽天市場",
				title: "商品A",
				url: "https://example.com/a",
				price: 39800,
				reviewAverage: 4.5,
				reviewCount: 12,
			},
		]);
		expect(text).toContain("[楽天市場] 商品A");
		expect(text).toContain("39,800円");
		expect(text).toContain("★4.5（12件）");
	});

	it("空でも壊れない", () => {
		expect(formatProducts([])).toContain("見つかりませんでした");
	});
});
