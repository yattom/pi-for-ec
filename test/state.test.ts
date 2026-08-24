import { describe, expect, it } from "vitest";
import {
	applyRequirements,
	candidateIdFor,
	emptyState,
	formatCandidates,
	formatRequirements,
	missingRequirementFields,
	removeCandidate,
	setCandidateStatus,
	upsertCandidate,
} from "../extensions/ec-concierge/state.ts";

describe("applyRequirements", () => {
	it("スカラー項目を上書きし、リストは追記する", () => {
		let state = emptyState();
		state = applyRequirements(state, { goal: "花粉症対策", mustHave: ["静音"] });
		state = applyRequirements(state, { goal: "花粉とハウスダスト対策", mustHave: ["フィルター交換が年1回以下"] });
		expect(state.requirements.goal).toBe("花粉とハウスダスト対策");
		expect(state.requirements.mustHave).toEqual(["静音", "フィルター交換が年1回以下"]);
	});

	it("同じ項目を重複させない", () => {
		let state = applyRequirements(emptyState(), { mustHave: ["静音"] });
		state = applyRequirements(state, { mustHave: ["静音", " 静音 "] });
		expect(state.requirements.mustHave).toEqual(["静音"]);
	});

	it("replaceLists ならリストを置き換える", () => {
		let state = applyRequirements(emptyState(), { mustHave: ["静音", "軽い"] });
		state = applyRequirements(state, { mustHave: ["軽い"] }, { replaceLists: true });
		expect(state.requirements.mustHave).toEqual(["軽い"]);
	});

	it("未指定の項目は保持する", () => {
		let state = applyRequirements(emptyState(), { budgetMax: 50000, category: "空気清浄機" });
		state = applyRequirements(state, { goal: "花粉症" });
		expect(state.requirements.budgetMax).toBe(50000);
		expect(state.requirements.category).toBe("空気清浄機");
	});
});

describe("candidateIdFor", () => {
	it("ホスト名とパス末尾から短いIDを作る", () => {
		expect(candidateIdFor("https://www.kakaku.com/item/K0001234/")).toBe("kakaku.com/item-K0001234");
		expect(candidateIdFor("https://item.rakuten.co.jp/shop/10000/")).toBe("item.rakuten.co.jp/shop-10000");
	});

	it("URLでなくても落ちない", () => {
		expect(candidateIdFor("not-a-url")).toBe("not-a-url");
	});
});

describe("候補の管理", () => {
	it("同じURLは統合し、pros/cons/根拠をマージする", () => {
		let state = upsertCandidate(emptyState(), {
			url: "https://kakaku.com/item/K1/",
			title: "商品A",
			price: 39800,
			pros: ["静か"],
			evidence: ["https://review.example/1"],
		});
		state = upsertCandidate(state, {
			url: "https://kakaku.com/item/K1/",
			cons: ["フィルターが高い"],
			pros: ["静か", "軽い"],
			evidence: ["https://review.example/2"],
		});
		expect(state.candidates).toHaveLength(1);
		expect(state.candidates[0]).toMatchObject({
			title: "商品A",
			price: 39800,
			pros: ["静か", "軽い"],
			cons: ["フィルターが高い"],
			evidence: ["https://review.example/1", "https://review.example/2"],
			status: "candidate",
		});
	});

	it("状態変更と除外理由を記録する", () => {
		let state = upsertCandidate(emptyState(), { url: "https://kakaku.com/item/K1/", title: "商品A" });
		const id = state.candidates[0]!.id;
		state = setCandidateStatus(state, id, "rejected", "予算オーバー");
		expect(state.candidates[0]).toMatchObject({ status: "rejected", rejectedReason: "予算オーバー" });

		state = setCandidateStatus(state, id, "shortlisted");
		expect(state.candidates[0]?.status).toBe("shortlisted");
		expect(state.candidates[0]?.rejectedReason).toBeUndefined();
	});

	it("削除できる", () => {
		let state = upsertCandidate(emptyState(), { url: "https://kakaku.com/item/K1/" });
		state = removeCandidate(state, state.candidates[0]!.id);
		expect(state.candidates).toHaveLength(0);
	});
});

describe("表示整形", () => {
	it("要件を読める形にする", () => {
		const state = applyRequirements(emptyState(), {
			goal: "花粉症対策",
			budgetMin: 20000,
			budgetMax: 50000,
			mustHave: ["静音"],
		});
		const text = formatRequirements(state.requirements);
		expect(text).toContain("解決したいこと: 花粉症対策");
		expect(text).toContain("予算: 20,000円 〜 50,000円");
		expect(text).toContain("必須条件: 静音");
	});

	it("空の要件でも案内を返す", () => {
		expect(formatRequirements(emptyState().requirements)).toContain("まだ何も聞き取れていません");
	});

	it("足りない項目を列挙する", () => {
		const missing = missingRequirementFields(emptyState().requirements);
		expect(missing).toContain("解決したい問題・用途");
		expect(missing).toContain("予算の上限");
	});

	it("候補一覧に状態と根拠を出す", () => {
		let state = upsertCandidate(emptyState(), {
			url: "https://kakaku.com/item/K1/",
			title: "商品A",
			price: 39800,
			why: "予算内で静音性が高い",
			evidence: ["https://review.example/1"],
		});
		state = setCandidateStatus(state, state.candidates[0]!.id, "shortlisted");
		const text = formatCandidates(state.candidates);
		expect(text).toContain("★最終候補");
		expect(text).toContain("39,800円");
		expect(text).toContain("理由: 予算内で静音性が高い");
		expect(text).toContain("根拠: https://review.example/1");
	});
});
