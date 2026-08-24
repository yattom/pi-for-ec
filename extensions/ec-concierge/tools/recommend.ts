/**
 * recommend ツール: 最終的なおすすめリストを提示し、Markdown レポートとして保存する。
 * 「理由・価格・購入リンク・根拠」をそろえて出すことを構造で強制するのが狙い。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Services } from "../services.ts";
import { type ConciergeState, formatRequirements } from "../state.ts";
import { formatJpy, slugify, timestampForFilename } from "../util.ts";

export interface RecommendDetails {
	savedPath?: string;
	itemCount: number;
	state: ConciergeState;
}

const PurchaseOption = Type.Object({
	shop: Type.String({ description: "販売店名（例: 楽天市場 ○○ストア、Amazon.co.jp）" }),
	url: Type.String({ description: "購入ページのURL" }),
	price: Type.Optional(Type.Number({ description: "価格（円、税込）" })),
	note: Type.Optional(Type.String({ description: "送料・ポイント・在庫などの補足" })),
});

const RecommendItem = Type.Object({
	rank: Type.Number({ description: "順位（1が最有力）" }),
	title: Type.String({ description: "商品名・型番" }),
	headline: Type.String({ description: "一言でいうとどういう選択肢か（30字程度）" }),
	why: Type.String({ description: "この人の要件にどう合うか。要件の言葉を使って具体的に。" }),
	price_note: Type.Optional(Type.String({ description: "価格の目安と変動状況（例: 実売4.2万円前後、型落ちで下落中）" })),
	pros: Type.Array(Type.String(), { description: "良い点（2〜4個）" }),
	cons: Type.Array(Type.String(), { description: "妥協点・注意点（1〜3個、必ず書く）" }),
	purchase_options: Type.Array(PurchaseOption, { description: "購入可能なページ（1〜3件）" }),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "根拠にしたレビュー等のURL" })),
	candidate_id: Type.Optional(Type.String({ description: "candidates ツール上のID（あれば）" })),
});

const Params = Type.Object({
	summary: Type.String({ description: "全体の結論を2〜4文で。何を基準に選んだかを明示する。" }),
	items: Type.Array(RecommendItem, { description: "おすすめ商品（1〜5件、rank 昇順）" }),
	also_considered: Type.Optional(
		Type.Array(Type.String(), { description: "検討したが外した候補と、その理由" }),
	),
	next_steps: Type.Optional(Type.Array(Type.String(), { description: "ユーザーが次に取るとよい行動" })),
	save_markdown: Type.Optional(Type.Boolean({ description: "Markdownファイルに保存する（既定 true）" })),
});

type RecommendParams = {
	summary: string;
	items: Array<{
		rank: number;
		title: string;
		headline: string;
		why: string;
		price_note?: string;
		pros: string[];
		cons: string[];
		purchase_options: Array<{ shop: string; url: string; price?: number; note?: string }>;
		evidence?: string[];
		candidate_id?: string;
	}>;
	also_considered?: string[];
	next_steps?: string[];
	save_markdown?: boolean;
};

/** 提案内容を Markdown に整形する。 */
export function buildRecommendationMarkdown(
	params: RecommendParams,
	state: ConciergeState,
	generatedAt = new Date(),
): string {
	const lines: string[] = [];
	lines.push(`# おすすめリスト（${generatedAt.toLocaleString("ja-JP")}）`);
	lines.push("");
	lines.push("## 結論");
	lines.push(params.summary);
	lines.push("");
	lines.push("## 聞き取った要件");
	lines.push(formatRequirements(state.requirements));
	lines.push("");
	lines.push("## おすすめ");

	for (const item of [...params.items].sort((a, b) => a.rank - b.rank)) {
		lines.push("");
		lines.push(`### ${item.rank}. ${item.title}`);
		lines.push(`**${item.headline}**`);
		lines.push("");
		lines.push(`- おすすめの理由: ${item.why}`);
		if (item.price_note) lines.push(`- 価格: ${item.price_note}`);
		if (item.pros.length) lines.push(`- 良い点: ${item.pros.map((pro) => `\n  - ${pro}`).join("")}`);
		if (item.cons.length) lines.push(`- 注意点: ${item.cons.map((con) => `\n  - ${con}`).join("")}`);
		if (item.purchase_options.length) {
			lines.push("- 購入できるページ:");
			for (const option of item.purchase_options) {
				const price = option.price !== undefined ? ` — ${formatJpy(option.price)}` : "";
				const note = option.note ? `（${option.note}）` : "";
				lines.push(`  - [${option.shop}](${option.url})${price}${note}`);
			}
		}
		if (item.evidence?.length) {
			lines.push("- 根拠:");
			for (const url of item.evidence) lines.push(`  - ${url}`);
		}
	}

	if (params.also_considered?.length) {
		lines.push("");
		lines.push("## 検討したが外したもの");
		for (const entry of params.also_considered) lines.push(`- ${entry}`);
	}
	if (params.next_steps?.length) {
		lines.push("");
		lines.push("## 次のステップ");
		for (const step of params.next_steps) lines.push(`- ${step}`);
	}
	lines.push("");
	lines.push("---");
	lines.push("価格・在庫は変動します。購入前に必ず販売ページで最新の情報を確認してください。");
	return lines.join("\n");
}

export function createRecommendTool(services: Services) {
	return defineTool({
		name: "recommend",
		label: "おすすめ提示",
		description:
			"最終的なおすすめリストを提示する。各商品について「理由・価格・購入リンク・良い点と注意点」を必ず添える。Markdownレポートとしても保存される。",
		promptSnippet: "最終的なおすすめリストを提示し、Markdownに保存する",
		promptGuidelines: [
			"最終提案は recommend ツールで出す。会話本文だけで済ませない。",
			"recommend の cons（注意点）は必ず1つ以上書く。良いことだけ並べない。",
		],
		parameters: Params,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as RecommendParams;
			const state = services.getState();
			const markdown = buildRecommendationMarkdown(params, state);

			let savedPath: string | undefined;
			if (params.save_markdown !== false) {
				const outputDir = services.getConfig().outputDir;
				const baseDir = isAbsolute(outputDir) ? outputDir : join(ctx.cwd, outputDir);
				const topic = params.items[0]?.title ?? state.requirements.category ?? "recommendation";
				const path = join(baseDir, `${timestampForFilename()}-${slugify(topic)}.md`);
				try {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, markdown, "utf8");
					savedPath = path;
				} catch (error) {
					savedPath = undefined;
					if (ctx.hasUI) {
						ctx.ui.notify(
							`おすすめリストの保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}
			}

			const footer = savedPath ? `\n\n（このリストを ${savedPath} に保存しました）` : "";
			return {
				content: [{ type: "text" as const, text: `${markdown}${footer}` }],
				details: { savedPath, itemCount: params.items.length, state } as RecommendDetails,
			};
		},
	});
}
