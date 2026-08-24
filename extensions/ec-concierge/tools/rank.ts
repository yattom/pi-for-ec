/**
 * rank_candidates ツール: 要件と候補を突き合わせてスコアを付ける。
 * rerank ロールのモデル（ローカルLLMでも十分実用的）に判定を任せる。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Services } from "../services.ts";
import { type Candidate, type ConciergeState, formatRequirements } from "../state.ts";
import { formatJpy } from "../util.ts";

export interface RankDetails {
	state: ConciergeState;
	ranking: RankEntry[];
	modelLabel?: string;
}

export interface RankEntry {
	id: string;
	score: number;
	reason: string;
}

const Params = Type.Object({
	focus: Type.Optional(
		Type.String({ description: "スコアリングで特に重視する観点（省略時は要件メモ全体）" }),
	),
	include_rejected: Type.Optional(Type.Boolean({ description: "除外済み候補も対象にする（既定 false）" })),
});

const RANK_SYSTEM_PROMPT =
	"あなたは買い物の要件と候補商品を突き合わせて優先順位をつける評価者です。要件との適合だけで判断し、知らない事実を作りません。";

export function buildRankPrompt(state: ConciergeState, candidates: readonly Candidate[], focus?: string): string {
	const list = candidates
		.map((candidate) => {
			const lines = [
				`id: ${candidate.id}`,
				`商品名: ${candidate.title}`,
				`価格: ${formatJpy(candidate.price)}`,
				candidate.shop ? `販売店: ${candidate.shop}` : undefined,
				candidate.pros.length ? `良い点: ${candidate.pros.join(" / ")}` : undefined,
				candidate.cons.length ? `懸念: ${candidate.cons.join(" / ")}` : undefined,
				candidate.why ? `メモ: ${candidate.why}` : undefined,
			].filter(Boolean);
			return lines.join("\n");
		})
		.join("\n---\n");

	return [
		"次の要件に対して、各候補が要件をどれだけ満たすかを0〜100点で評価してください。",
		focus ? `特に重視する観点: ${focus}` : "",
		"",
		"【要件】",
		formatRequirements(state.requirements),
		"",
		"【候補】",
		list,
		"",
		"出力は次の形式の JSON 配列のみ（説明文やコードフェンスは不要）:",
		'[{"id": "候補のid", "score": 0-100の整数, "reason": "60字以内の日本語で理由"}]',
		"必須条件を満たさない候補は40点未満にしてください。情報が不足していて判断できない点は reason に明記してください。",
	]
		.filter(Boolean)
		.join("\n");
}

/** モデル出力から JSON 配列を取り出す。コードフェンスや前後の文章が付いていても拾う。 */
export function parseRankResponse(text: string): RankEntry[] {
	const withoutFence = text.replace(/```(?:json)?/gi, "");
	const start = withoutFence.indexOf("[");
	const end = withoutFence.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutFence.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const entries: RankEntry[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : undefined;
		if (!id) continue;
		const rawScore = typeof record.score === "number" ? record.score : Number(record.score);
		const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
		entries.push({ id, score, reason: typeof record.reason === "string" ? record.reason : "" });
	}
	return entries.sort((a, b) => b.score - a.score);
}

export function createRankTool(services: Services) {
	return defineTool({
		name: "rank_candidates",
		label: "候補スコアリング",
		description:
			"要件メモと候補リストを突き合わせ、rerank ロールのモデルで各候補を0〜100点で採点して並べ替える。候補が4件以上あるときの絞り込みに使う。",
		promptSnippet: "候補を要件に照らして採点・並べ替えする",
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = services.getState();
			const targets = state.candidates.filter(
				(candidate) => params.include_rejected || candidate.status !== "rejected",
			);
			if (targets.length === 0) {
				return {
					content: [{ type: "text" as const, text: "採点対象の候補がありません。先に candidates(upsert) で候補を登録してください。" }],
					details: { state, ranking: [] } as RankDetails,
				};
			}

			const result = await services.roles.run(ctx, "rerank", {
				system: RANK_SYSTEM_PROMPT,
				prompt: buildRankPrompt(state, targets, params.focus),
				signal: services.signalOf(ctx, signal),
				maxTokens: 1500,
				temperature: 0,
			});
			const ranking = parseRankResponse(result.text);

			if (ranking.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `採点結果を JSON として解釈できませんでした（モデル: ${result.modelLabel}）。モデルの出力:\n${result.text.slice(0, 1000)}`,
						},
					],
					details: { state, ranking: [], modelLabel: result.modelLabel } as RankDetails,
					usage: result.usage,
				};
			}

			const scoreById = new Map(ranking.map((entry) => [entry.id, entry]));
			const nextState: ConciergeState = {
				...state,
				candidates: state.candidates.map((candidate) => {
					const entry = scoreById.get(candidate.id);
					return entry ? { ...candidate, score: entry.score } : candidate;
				}),
				updatedAt: Date.now(),
			};
			services.setState(nextState);

			const lines = ranking.map((entry, index) => {
				const candidate = nextState.candidates.find((item) => item.id === entry.id);
				return `${index + 1}. ${entry.score}点 ${candidate?.title ?? entry.id}\n   ${entry.reason}\n   ${candidate?.url ?? ""}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `採点モデル: ${result.modelLabel}\n\n${lines.join("\n")}`,
					},
				],
				details: { state: nextState, ranking, modelLabel: result.modelLabel } as RankDetails,
				usage: result.usage,
			};
		},
	});
}
