/**
 * review_research ツール: ECサイトの外にある独立系レビューを調べる。
 * 検索 → ページ取得 → review/translate ロールのモデルで要約、までを1回で行う。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewPageSummary } from "../reviews.ts";
import type { Services } from "../services.ts";

export interface ReviewResearchDetails {
	subject: string;
	pages: ReviewPageSummary[];
	searchErrors: string[];
}

const Params = Type.Object({
	subject: Type.String({ description: "調べたい商品名・型番、またはカテゴリ（例: 「シャープ KI-RX50」「7万円以下 空気清浄機」）" }),
	aspects: Type.Optional(
		Type.Array(Type.String(), { description: '重視する観点（例: ["静音性", "メンテナンス性", "電気代"]）' }),
	),
	include_international: Type.Optional(
		Type.Boolean({ description: "海外のレビューサイトも参照する（国際的に売られている製品向け。既定 false）" }),
	),
	max_pages: Type.Optional(Type.Number({ description: "読み込むページ数の上限（既定4、最大8）" })),
	site_ids: Type.Optional(
		Type.Array(Type.String(), { description: "設定に登録されたレビューサイトIDで対象を絞る（省略時は全サイト）" }),
	),
});

export function createReviewResearchTool(services: Services) {
	return defineTool({
		name: "review_research",
		label: "レビュー調査",
		description:
			"ECサイト以外の独立したレビュー（価格.comのクチコミ、専門メディア、海外レビューサイト等）を検索・読解し、良い点と悪い点に整理して返す。候補を絞り込む前に必ず使う。",
		promptSnippet: "独立系レビューサイトを調べて良い点・悪い点を整理する",
		promptGuidelines: [
			"おすすめを提示する前に review_research でEC外の評判を確認し、悪い点も必ず伝える。",
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await services.reviews.research(
				ctx,
				{
					subject: params.subject,
					aspects: params.aspects,
					includeInternational: params.include_international,
					maxPages: params.max_pages,
					siteIds: params.site_ids,
				},
				services.signalOf(ctx, signal),
			);

			const body = result.pages.length
				? result.pages
						.map((page, index) => {
							const header = `${index + 1}. [${page.site} / ${kindLabel(page.kind)}${page.lang !== "ja" ? " / 海外" : ""}] ${page.title}`;
							const meta = page.modelLabel ? `   要約モデル: ${page.modelLabel}` : "   （要約モデルなし: 抜粋のまま）";
							const error = page.error ? `   取得エラー: ${page.error}` : undefined;
							return [header, `   URL: ${page.url}`, meta, error, "", page.summary].filter(Boolean).join("\n");
						})
						.join("\n\n")
				: "（レビュー記事が見つかりませんでした。検索語を変えるか、site_ids を広げてください）";

			const errors = result.searchErrors.length ? `\n\n検索時のエラー:\n- ${result.searchErrors.join("\n- ")}` : "";

			return {
				content: [{ type: "text" as const, text: `調査対象: ${result.subject}\n\n${body}${errors}` }],
				details: {
					subject: result.subject,
					pages: result.pages,
					searchErrors: result.searchErrors,
				} as ReviewResearchDetails,
				usage: result.usage,
			};
		},
	});
}

function kindLabel(kind: ReviewPageSummary["kind"]): string {
	switch (kind) {
		case "editorial":
			return "専門メディア";
		case "user-review":
			return "利用者レビュー";
		default:
			return "コミュニティ";
	}
}
