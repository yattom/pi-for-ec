/**
 * コンシェルジュのセッション状態（要件メモと候補リスト）。
 *
 * pi の推奨に従い、状態はツール結果の details にスナップショットとして残し、
 * session_start でブランチを走査して復元する。これで /fork や /tree での分岐にも追従できる。
 */

export interface Requirements {
	/** 解決したい問題・目的 */
	goal?: string;
	/** 商品カテゴリ */
	category?: string;
	budgetMin?: number;
	budgetMax?: number;
	/** 必須条件 */
	mustHave: string[];
	/** あると嬉しい条件 */
	niceToHave: string[];
	/** これがあったら候補から外す条件 */
	dealBreakers: string[];
	/** 使う場所・頻度・使う人など */
	usageContext?: string;
	/** いつまでに必要か */
	deadline?: string;
	/** 好み・避けたい販売店やブランド */
	preferredShops: string[];
	/** その他メモ */
	notes: string[];
}

export type CandidateStatus = "candidate" | "shortlisted" | "rejected";

export interface Candidate {
	/** 安定キー（URL から自動採番） */
	id: string;
	title: string;
	url: string;
	/** 取得元 ("rakuten" / "web:kakaku" など) */
	source?: string;
	price?: number;
	shop?: string;
	status: CandidateStatus;
	/** 推す理由 */
	why?: string;
	pros: string[];
	cons: string[];
	/** 根拠として参照したURL */
	evidence: string[];
	/** 却下した理由 */
	rejectedReason?: string;
	/** rank_candidates が付けたスコア(0-100) */
	score?: number;
	notes?: string;
}

export interface ConciergeState {
	requirements: Requirements;
	candidates: Candidate[];
	updatedAt: number;
}

export function emptyState(): ConciergeState {
	return {
		requirements: {
			mustHave: [],
			niceToHave: [],
			dealBreakers: [],
			preferredShops: [],
			notes: [],
		},
		candidates: [],
		updatedAt: 0,
	};
}

export type RequirementsPatch = Partial<Omit<Requirements, "mustHave" | "niceToHave" | "dealBreakers" | "preferredShops" | "notes">> & {
	mustHave?: string[];
	niceToHave?: string[];
	dealBreakers?: string[];
	preferredShops?: string[];
	notes?: string[];
};

/** 配列項目は「置き換え」ではなく追記（重複除去）にする。消したいときは replaceLists を使う。 */
export function applyRequirements(
	state: ConciergeState,
	patch: RequirementsPatch,
	options: { replaceLists?: boolean } = {},
): ConciergeState {
	const current = state.requirements;
	const mergeList = (existing: string[], incoming?: string[]): string[] => {
		if (!incoming) return existing;
		if (options.replaceLists) return [...new Set(incoming.map((item) => item.trim()).filter(Boolean))];
		return [...new Set([...existing, ...incoming.map((item) => item.trim()).filter(Boolean)])];
	};
	return {
		...state,
		requirements: {
			goal: patch.goal ?? current.goal,
			category: patch.category ?? current.category,
			budgetMin: patch.budgetMin ?? current.budgetMin,
			budgetMax: patch.budgetMax ?? current.budgetMax,
			usageContext: patch.usageContext ?? current.usageContext,
			deadline: patch.deadline ?? current.deadline,
			mustHave: mergeList(current.mustHave, patch.mustHave),
			niceToHave: mergeList(current.niceToHave, patch.niceToHave),
			dealBreakers: mergeList(current.dealBreakers, patch.dealBreakers),
			preferredShops: mergeList(current.preferredShops, patch.preferredShops),
			notes: mergeList(current.notes, patch.notes),
		},
		updatedAt: Date.now(),
	};
}

export function candidateIdFor(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("-");
		return `${parsed.hostname.replace(/^www\./, "")}${path ? `/${path}` : ""}`.slice(0, 80);
	} catch {
		return url.slice(0, 80);
	}
}

export type CandidateInput = Omit<Partial<Candidate>, "id"> & { url: string; title?: string };

/** 同じURLの候補があれば統合し、無ければ追加する。 */
export function upsertCandidate(state: ConciergeState, input: CandidateInput): ConciergeState {
	const id = candidateIdFor(input.url);
	const existingIndex = state.candidates.findIndex((candidate) => candidate.id === id);
	const base: Candidate = state.candidates[existingIndex] ?? {
		id,
		title: input.title ?? input.url,
		url: input.url,
		status: "candidate",
		pros: [],
		cons: [],
		evidence: [],
	};
	const merged: Candidate = {
		...base,
		...input,
		id,
		title: input.title ?? base.title,
		pros: [...new Set([...base.pros, ...(input.pros ?? [])])],
		cons: [...new Set([...base.cons, ...(input.cons ?? [])])],
		evidence: [...new Set([...base.evidence, ...(input.evidence ?? [])])],
		status: input.status ?? base.status,
	};
	const candidates = [...state.candidates];
	if (existingIndex >= 0) candidates[existingIndex] = merged;
	else candidates.push(merged);
	return { ...state, candidates, updatedAt: Date.now() };
}

export function removeCandidate(state: ConciergeState, id: string): ConciergeState {
	return { ...state, candidates: state.candidates.filter((candidate) => candidate.id !== id), updatedAt: Date.now() };
}

export function setCandidateStatus(
	state: ConciergeState,
	id: string,
	status: CandidateStatus,
	reason?: string,
): ConciergeState {
	return {
		...state,
		candidates: state.candidates.map((candidate) =>
			candidate.id === id
				? { ...candidate, status, rejectedReason: status === "rejected" ? (reason ?? candidate.rejectedReason) : undefined }
				: candidate,
		),
		updatedAt: Date.now(),
	};
}

/** 要件メモを人が読める形に整形する。 */
export function formatRequirements(requirements: Requirements): string {
	const lines: string[] = [];
	const push = (label: string, value?: string | number) => {
		if (value !== undefined && value !== "") lines.push(`- ${label}: ${value}`);
	};
	push("解決したいこと", requirements.goal);
	push("カテゴリ", requirements.category);
	if (requirements.budgetMin !== undefined || requirements.budgetMax !== undefined) {
		const min = requirements.budgetMin !== undefined ? `${requirements.budgetMin.toLocaleString("ja-JP")}円` : "下限なし";
		const max = requirements.budgetMax !== undefined ? `${requirements.budgetMax.toLocaleString("ja-JP")}円` : "上限なし";
		lines.push(`- 予算: ${min} 〜 ${max}`);
	}
	push("使用状況", requirements.usageContext);
	push("時期", requirements.deadline);
	const pushList = (label: string, items: string[]) => {
		if (items.length > 0) lines.push(`- ${label}: ${items.join(" / ")}`);
	};
	pushList("必須条件", requirements.mustHave);
	pushList("あると嬉しい", requirements.niceToHave);
	pushList("これは避けたい", requirements.dealBreakers);
	pushList("販売店の希望", requirements.preferredShops);
	pushList("メモ", requirements.notes);
	return lines.length > 0 ? lines.join("\n") : "(まだ何も聞き取れていません)";
}

/** 要件のうち、まだ埋まっていない重要項目を返す（次の質問を決めるヒント）。 */
export function missingRequirementFields(requirements: Requirements): string[] {
	const missing: string[] = [];
	if (!requirements.goal) missing.push("解決したい問題・用途");
	if (requirements.budgetMax === undefined) missing.push("予算の上限");
	if (requirements.mustHave.length === 0) missing.push("外せない条件");
	if (!requirements.usageContext) missing.push("使う場所・頻度・使う人");
	return missing;
}

export function formatCandidates(candidates: readonly Candidate[]): string {
	if (candidates.length === 0) return "(候補はまだありません)";
	return candidates
		.map((candidate) => {
			const price = candidate.price !== undefined ? `${candidate.price.toLocaleString("ja-JP")}円` : "価格未確認";
			const score = candidate.score !== undefined ? ` スコア:${candidate.score}` : "";
			const status =
				candidate.status === "shortlisted" ? "★最終候補" : candidate.status === "rejected" ? "×除外" : "・候補";
			const detail = [
				candidate.why ? `理由: ${candidate.why}` : undefined,
				candidate.pros.length > 0 ? `良い点: ${candidate.pros.join(" / ")}` : undefined,
				candidate.cons.length > 0 ? `懸念: ${candidate.cons.join(" / ")}` : undefined,
				candidate.rejectedReason ? `除外理由: ${candidate.rejectedReason}` : undefined,
				candidate.evidence.length > 0 ? `根拠: ${candidate.evidence.join(", ")}` : undefined,
			]
				.filter(Boolean)
				.map((line) => `    ${line}`)
				.join("\n");
			return `${status} [${candidate.id}]${score} ${candidate.title}\n    ${price}${candidate.shop ? ` / ${candidate.shop}` : ""}\n    ${candidate.url}${detail ? `\n${detail}` : ""}`;
		})
		.join("\n");
}
