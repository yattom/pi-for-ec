/**
 * ec_search ツール: 日本のECサイトを横断して商品を検索する。
 * 楽天市場・Yahoo!ショッピングは公式API、それ以外はサイト指定のWeb検索で辿る。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatProducts } from "../ec/index.ts";
import type { Product } from "../ec/types.ts";
import type { Services } from "../services.ts";

export interface EcSearchDetails {
	keyword: string;
	sources: string[];
	products: Product[];
	errors: Array<{ source: string; message: string }>;
}

const Params = Type.Object({
	keyword: Type.String({ description: "商品名・型番・カテゴリなどの検索語（日本語）" }),
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'検索対象のソースID。省略時は設定の既定値。例: ["rakuten", "yahoo", "amazon", "kakaku", "yodobashi"]',
		}),
	),
	min_price: Type.Optional(Type.Number({ description: "価格の下限（円）" })),
	max_price: Type.Optional(Type.Number({ description: "価格の上限（円）" })),
	sort: Type.Optional(
		StringEnum(["relevance", "price-asc", "price-desc", "review"] as const, {
			description: "並び順（既定 relevance）",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "1ソースあたりの取得件数（既定10）" })),
});

export function createEcSearchTool(services: Services) {
	return defineTool({
		name: "ec_search",
		label: "EC検索",
		description:
			"日本のECサイト（楽天市場・Yahoo!ショッピング・Amazon・価格.com・ヨドバシ等）を横断して商品と価格を調べる。実売価格や在庫を知りたいときに使う。",
		promptSnippet: "日本のECサイトを横断して商品と価格を検索する",
		promptGuidelines: [
			"価格や購入先を示すときは ec_search の結果を根拠にし、URLを必ず添える。",
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await services.ec.search(
				{
					keyword: params.keyword,
					minPrice: params.min_price,
					maxPrice: params.max_price,
					sort: params.sort,
					limit: params.limit,
				},
				{ sources: params.sources, signal: services.signalOf(ctx, signal) },
			);

			const errorText = outcome.errors.length
				? `\n\n利用できなかったソース:\n${outcome.errors.map((error) => `- ${error.source}: ${error.message}`).join("\n")}`
				: "";

			return {
				content: [
					{
						type: "text" as const,
						text: `検索語: ${params.keyword}\n対象: ${outcome.sources.join(", ") || "(なし)"}\n\n${formatProducts(outcome.products)}${errorText}`,
					},
				],
				details: {
					keyword: params.keyword,
					sources: outcome.sources,
					products: outcome.products,
					errors: outcome.errors,
				} as EcSearchDetails,
			};
		},
	});
}
