/**
 * ask_user ツール: コンシェルジュがユーザーに確認を取るための質問ツール。
 *
 * TUI では選択肢ダイアログ（+ 自由入力）を出す。
 * 非対話モード（-p / json）では質問文をそのまま返し、モデルに「本文で聞く」よう促す。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const FREE_TEXT_LABEL = "その他（自由に入力する）";
const SKIP_LABEL = "わからない / おまかせ";

export interface AskUserDetails {
	question: string;
	options: string[];
	answers: string[];
	cancelled: boolean;
}

const Params = Type.Object({
	question: Type.String({ description: "ユーザーへの質問。1回につき1つの論点に絞ること。" }),
	options: Type.Array(Type.String(), {
		description: "選びやすい選択肢（2〜6個程度）。自由入力と「おまかせ」は自動で追加される。",
		default: [],
	}),
	mode: Type.Optional(
		StringEnum(["single", "multi"] as const, {
			description: "single: 1つ選ぶ / multi: 複数選ぶ（複数選択は自由入力で受け付ける）",
		}),
	),
	why: Type.Optional(Type.String({ description: "なぜこれを聞くのかの一言説明。ユーザーに表示される。" })),
});

export function createAskUserTool() {
	return defineTool({
		name: "ask_user",
		label: "質問",
		description:
			"ユーザーに質問して回答を得る。要件が曖昧なとき、候補を絞る判断が必要なとき、最終決定の前に必ず使う。1回の呼び出しにつき質問は1つ。",
		promptSnippet: "ユーザーに選択肢つきの質問をする",
		promptGuidelines: [
			"要件が不足しているときは推測で進めず ask_user で確認する。",
			"ask_user は1回につき1つの論点だけを聞き、選択肢を2〜6個添える。",
		],
		parameters: Params,
		// ダイアログを出すので他ツールと同時実行しない
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = params.options.filter((option) => option.trim().length > 0);

			if (!ctx.hasUI) {
				// 非対話モードではダイアログを出せないので、質問内容を返してモデルに委ねる
				return {
					content: [
						{
							type: "text" as const,
							text: [
								"（対話UIが使えないため質問ダイアログは表示していません。以下の質問を本文でユーザーに投げかけてください）",
								params.why ? `意図: ${params.why}` : undefined,
								`質問: ${params.question}`,
								options.length > 0 ? `選択肢: ${options.join(" / ")}` : undefined,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: { question: params.question, options, answers: [], cancelled: false } as AskUserDetails,
				};
			}

			const title = params.why ? `${params.question}（${params.why}）` : params.question;
			const answers: string[] = [];

			if (options.length > 0) {
				const choice = await ctx.ui.select(title, [...options, FREE_TEXT_LABEL, SKIP_LABEL]);
				if (choice === undefined) {
					return {
						content: [{ type: "text" as const, text: "ユーザーは回答をキャンセルしました。別の切り口で確認するか、先に進める提案をしてください。" }],
						details: { question: params.question, options, answers: [], cancelled: true } as AskUserDetails,
					};
				}
				if (choice === FREE_TEXT_LABEL) {
					const typed = await ctx.ui.input(params.question, params.mode === "multi" ? "複数ある場合は「、」で区切って入力" : "自由に入力");
					if (typed?.trim()) answers.push(typed.trim());
				} else if (choice === SKIP_LABEL) {
					answers.push("わからない / おまかせ");
				} else {
					answers.push(choice);
					if (params.mode === "multi") {
						const extra = await ctx.ui.input("他にもあれば入力してください（無ければ空のままEnter）", "例: 静音性も重視");
						if (extra?.trim()) answers.push(extra.trim());
					}
				}
			} else {
				const typed = await ctx.ui.input(title, "自由に入力");
				if (typed?.trim()) answers.push(typed.trim());
			}

			if (answers.length === 0) {
				return {
					content: [{ type: "text" as const, text: "ユーザーは回答をスキップしました。この点は仮置きで進め、後で確認してください。" }],
					details: { question: params.question, options, answers: [], cancelled: true } as AskUserDetails,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `質問: ${params.question}\nユーザーの回答: ${answers.join(" / ")}`,
					},
				],
				details: { question: params.question, options, answers, cancelled: false } as AskUserDetails,
			};
		},
	});
}
