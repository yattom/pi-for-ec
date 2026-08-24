/**
 * web_search / web_fetch ツール。
 *
 * どちらも pi を動かしているマシンから HTTP を発行する。
 * 取得したページは（長ければ）extract ロールのモデルで要約してから
 * メインの会話モデルに渡すので、ローカルLLMを下働きにするとコンテキストと費用を節約できる。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatSearchResults } from "../search/index.ts";
import type { Services } from "../services.ts";
import { extractDescription, extractTitle, truncate } from "../util.ts";

export interface WebSearchDetails {
	query: string;
	backend?: string;
	count: number;
	urls: string[];
}

export interface WebFetchDetails {
	url: string;
	title?: string;
	summarized: boolean;
	modelLabel?: string;
	chars: number;
}

const SearchParams = Type.Object({
	query: Type.String({ description: "検索クエリ。日本語で具体的に。" }),
	sites: Type.Optional(
		Type.Array(Type.String(), {
			description: 'ドメインで絞り込む場合に指定（例: ["kakaku.com", "my-best.com"]）',
		}),
	),
	count: Type.Optional(Type.Number({ description: "取得件数（既定8、最大20）" })),
	lang: Type.Optional(StringEnum(["ja", "any"] as const, { description: "ja: 日本語優先（既定） / any: 言語制約なし" })),
});

export function createWebSearchTool(services: Services) {
	return defineTool({
		name: "web_search",
		label: "Web検索",
		description:
			"Web検索を実行する（実行マシンから発行）。商品の一般情報、比較記事、型番の確認などに使う。ECサイトの商品検索には ec_search、レビュー調査には review_research を優先する。",
		promptSnippet: "実行マシンからWeb検索を行う",
		parameters: SearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await services.search.search(
				{
					query: params.query,
					sites: params.sites,
					count: params.count,
					lang: params.lang ?? "ja",
				},
				services.signalOf(ctx, signal),
			);
			const attempts = outcome.attempts.length
				? `\n（試行: ${outcome.attempts.map((attempt) => `${attempt.backend}=${attempt.error}`).join(", ")}）`
				: "";
			return {
				content: [
					{
						type: "text" as const,
						text: `検索: ${params.query}\nバックエンド: ${outcome.backend}${attempts}\n\n${formatSearchResults(outcome.results)}`,
					},
				],
				details: {
					query: params.query,
					backend: outcome.backend,
					count: outcome.results.length,
					urls: outcome.results.map((result) => result.url),
				} as WebSearchDetails,
			};
		},
	});
}

const FetchParams = Type.Object({
	url: Type.String({ description: "取得するページのURL" }),
	purpose: Type.Optional(
		Type.String({
			description: "このページから何を知りたいか（例: 「型番と実売価格と保証期間」）。要約の焦点になる。",
		}),
	),
	summarize: Type.Optional(
		StringEnum(["auto", "always", "never"] as const, {
			description: "auto: 長いページだけ要約（既定） / always: 必ず要約 / never: 本文をそのまま返す",
		}),
	),
	max_chars: Type.Optional(Type.Number({ description: "本文をそのまま返すときの最大文字数（既定6000）" })),
});

const EXTRACT_SYSTEM_PROMPT =
	"あなたはWebページから購入判断に必要な事実だけを抜き出すアシスタントです。ページに書かれていないことは書かず、価格・型番・数値仕様は原文の表記のまま残します。";

export function buildExtractPrompt(options: { url: string; title?: string; purpose?: string; text: string }): string {
	return [
		"次のWebページから、買い物の判断に使える情報を抽出してください。",
		options.purpose ? `特に知りたいこと: ${options.purpose}` : "特に商品名・型番・価格・主要スペック・在庫や配送条件・注意点を優先してください。",
		"",
		"出力形式（Markdown、600字以内）:",
		"- ページの種類: 商品ページ / 比較記事 / レビュー / その他",
		"- 商品名・型番:",
		"- 価格（税込/税別の表記も原文のまま）:",
		"- 主要スペック: 箇条書き",
		"- 販売条件（在庫・送料・保証・ポイント等）:",
		"- 注意点・気になる記述:",
		"",
		"該当する情報がない項目には「記載なし」と書いてください。推測は禁止です。",
		"",
		`URL: ${options.url}`,
		options.title ? `タイトル: ${options.title}` : "",
		"---",
		options.text,
	]
		.filter(Boolean)
		.join("\n");
}

export function createWebFetchTool(services: Services) {
	return defineTool({
		name: "web_fetch",
		label: "ページ取得",
		description:
			"URLのページを取得して読む（実行マシンから取得、robots.txt を尊重）。長いページは extract ロールのモデルで要約してから返す。",
		promptSnippet: "URLのページを取得し、必要なら要約して読む",
		promptGuidelines: [
			"商品ページの価格やスペックを確定させるときは web_fetch で実ページを確認する。",
		],
		parameters: FetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = services.getConfig();
			const abort = services.signalOf(ctx, signal);
			const maxChars = params.max_chars ?? config.summarizeThresholdChars;
			const fetched = await services.http.fetchText(params.url, { signal: abort });
			const title = fetched.html ? extractTitle(fetched.html) : undefined;
			const description = fetched.html ? extractDescription(fetched.html) : undefined;

			const mode = params.summarize ?? "auto";
			const shouldSummarize =
				mode === "always" || (mode === "auto" && fetched.text.length > config.summarizeThresholdChars);

			if (shouldSummarize) {
				const summarized = await services.roles.tryRun(ctx, "extract", {
					system: EXTRACT_SYSTEM_PROMPT,
					prompt: buildExtractPrompt({
						url: fetched.finalUrl,
						title,
						purpose: params.purpose,
						text: truncate(fetched.text, config.summarizeThresholdChars * 4),
					}),
					signal: abort,
					maxTokens: 1200,
				});
				if (summarized) {
					return {
						content: [
							{
								type: "text" as const,
								text: [
									`URL: ${fetched.finalUrl}`,
									title ? `タイトル: ${title}` : undefined,
									`要約モデル: ${summarized.modelLabel}（本文 ${fetched.text.length} 文字を要約）`,
									"",
									summarized.text,
								]
									.filter(Boolean)
									.join("\n"),
							},
						],
						details: {
							url: fetched.finalUrl,
							title,
							summarized: true,
							modelLabel: summarized.modelLabel,
							chars: fetched.text.length,
						} as WebFetchDetails,
						usage: summarized.usage,
					};
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`URL: ${fetched.finalUrl}`,
							title ? `タイトル: ${title}` : undefined,
							description ? `説明: ${description}` : undefined,
							"",
							truncate(fetched.text, maxChars),
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { url: fetched.finalUrl, title, summarized: false, chars: fetched.text.length } as WebFetchDetails,
			};
		},
	});
}
