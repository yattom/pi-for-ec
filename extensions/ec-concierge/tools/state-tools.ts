/**
 * requirements / candidates ツール: ヒアリング結果と候補リストを保持する。
 *
 * 状態はツール結果の details にスナップショットとして残す（pi の推奨パターン）。
 * これにより /fork や /tree で分岐しても、その枝の状態が復元される。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Services } from "../services.ts";
import {
	type CandidateStatus,
	type ConciergeState,
	applyRequirements,
	formatCandidates,
	formatRequirements,
	missingRequirementFields,
	removeCandidate,
	setCandidateStatus,
	upsertCandidate,
} from "../state.ts";

export interface StateDetails {
	state: ConciergeState;
}

const RequirementsParams = Type.Object({
	action: StringEnum(["get", "update", "replace_lists"] as const, {
		description: "get: 現在の要件を読む / update: 追記更新 / replace_lists: 配列項目を置き換える",
	}),
	goal: Type.Optional(Type.String({ description: "解決したい問題・目的" })),
	category: Type.Optional(Type.String({ description: "商品カテゴリ" })),
	budget_min: Type.Optional(Type.Number({ description: "予算の下限（円）" })),
	budget_max: Type.Optional(Type.Number({ description: "予算の上限（円）" })),
	usage_context: Type.Optional(Type.String({ description: "使う場所・頻度・使う人など" })),
	deadline: Type.Optional(Type.String({ description: "いつまでに必要か" })),
	must_have: Type.Optional(Type.Array(Type.String(), { description: "外せない条件" })),
	nice_to_have: Type.Optional(Type.Array(Type.String(), { description: "あると嬉しい条件" })),
	deal_breakers: Type.Optional(Type.Array(Type.String(), { description: "これがあると候補から外す条件" })),
	preferred_shops: Type.Optional(Type.Array(Type.String(), { description: "希望・回避したい販売店やブランド" })),
	notes: Type.Optional(Type.Array(Type.String(), { description: "その他のメモ" })),
});

export function createRequirementsTool(services: Services) {
	return defineTool({
		name: "requirements",
		label: "要件メモ",
		description:
			"ユーザーから聞き取った要件（目的・予算・必須条件など）を記録・参照する。ヒアリングで新しい情報が出たらすぐ update すること。",
		promptSnippet: "ヒアリングした要件を記録・参照する",
		promptGuidelines: [
			"ユーザーの発言から要件が判明したら、その都度 requirements(update) で記録する。",
		],
		parameters: RequirementsParams,

		async execute(_toolCallId, params) {
			let state = services.getState();
			if (params.action !== "get") {
				state = applyRequirements(
					state,
					{
						goal: params.goal,
						category: params.category,
						budgetMin: params.budget_min,
						budgetMax: params.budget_max,
						usageContext: params.usage_context,
						deadline: params.deadline,
						mustHave: params.must_have,
						niceToHave: params.nice_to_have,
						dealBreakers: params.deal_breakers,
						preferredShops: params.preferred_shops,
						notes: params.notes,
					},
					{ replaceLists: params.action === "replace_lists" },
				);
				services.setState(state);
			}

			const missing = missingRequirementFields(state.requirements);
			const missingText = missing.length > 0 ? `\n\nまだ聞けていない項目: ${missing.join(" / ")}` : "\n\n主要な要件は揃っています。";

			return {
				content: [{ type: "text" as const, text: `現在の要件:\n${formatRequirements(state.requirements)}${missingText}` }],
				details: { state } as StateDetails,
			};
		},
	});
}

const CandidateFields = {
	url: Type.String({ description: "商品ページのURL（候補の一意キーになる）" }),
	title: Type.Optional(Type.String({ description: "商品名" })),
	source: Type.Optional(Type.String({ description: "取得元（rakuten / yahoo / web:kakaku など）" })),
	price: Type.Optional(Type.Number({ description: "価格（円、税込）" })),
	shop: Type.Optional(Type.String({ description: "販売店" })),
	why: Type.Optional(Type.String({ description: "この候補を推す理由" })),
	pros: Type.Optional(Type.Array(Type.String(), { description: "良い点" })),
	cons: Type.Optional(Type.Array(Type.String(), { description: "懸念点" })),
	evidence: Type.Optional(Type.Array(Type.String(), { description: "根拠にしたURL" })),
	notes: Type.Optional(Type.String({ description: "補足メモ" })),
};

const CandidatesParams = Type.Object({
	action: StringEnum(["list", "upsert", "status", "remove", "clear"] as const, {
		description: "list: 一覧 / upsert: 追加・更新 / status: 状態変更 / remove: 削除 / clear: 全消去",
	}),
	candidates: Type.Optional(
		Type.Array(Type.Object(CandidateFields), { description: "upsert する候補（複数可）" }),
	),
	id: Type.Optional(Type.String({ description: "status / remove の対象ID（list の結果に表示される）" })),
	status: Type.Optional(
		StringEnum(["candidate", "shortlisted", "rejected"] as const, {
			description: "status アクションで設定する状態",
		}),
	),
	reason: Type.Optional(Type.String({ description: "rejected にする場合の理由" })),
});

export function createCandidatesTool(services: Services) {
	return defineTool({
		name: "candidates",
		label: "候補リスト",
		description:
			"検討中の商品候補を管理する。調べた商品は candidates(upsert) で登録し、絞り込みの過程は status で記録する。最終提案は shortlisted の候補から選ぶ。",
		promptSnippet: "商品候補の登録・絞り込み状況を管理する",
		promptGuidelines: [
			"候補を見つけたら candidates(upsert) に登録し、除外したときは status=rejected と理由を残す。",
		],
		parameters: CandidatesParams,

		async execute(_toolCallId, params) {
			let state = services.getState();

			switch (params.action) {
				case "upsert": {
					for (const candidate of params.candidates ?? []) {
						state = upsertCandidate(state, {
							url: candidate.url,
							title: candidate.title,
							source: candidate.source,
							price: candidate.price,
							shop: candidate.shop,
							why: candidate.why,
							pros: candidate.pros,
							cons: candidate.cons,
							evidence: candidate.evidence,
							notes: candidate.notes,
						});
					}
					break;
				}
				case "status": {
					if (!params.id || !params.status) throw new Error("status アクションには id と status が必要です");
					if (!state.candidates.some((candidate) => candidate.id === params.id)) {
						throw new Error(`候補 ${params.id} が見つかりません。candidates(list) で確認してください。`);
					}
					state = setCandidateStatus(state, params.id, params.status as CandidateStatus, params.reason);
					break;
				}
				case "remove": {
					if (!params.id) throw new Error("remove アクションには id が必要です");
					state = removeCandidate(state, params.id);
					break;
				}
				case "clear": {
					state = { ...state, candidates: [], updatedAt: Date.now() };
					break;
				}
				default:
					break;
			}

			services.setState(state);
			const summary = summarizeCandidates(state);
			return {
				content: [{ type: "text" as const, text: `${summary}\n\n${formatCandidates(state.candidates)}` }],
				details: { state } as StateDetails,
			};
		},
	});
}

export function summarizeCandidates(state: ConciergeState): string {
	const counts = state.candidates.reduce(
		(acc, candidate) => {
			acc[candidate.status] += 1;
			return acc;
		},
		{ candidate: 0, shortlisted: 0, rejected: 0 } as Record<CandidateStatus, number>,
	);
	return `候補: 検討中 ${counts.candidate} 件 / 最終候補 ${counts.shortlisted} 件 / 除外 ${counts.rejected} 件`;
}
