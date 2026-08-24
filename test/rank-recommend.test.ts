import { describe, expect, it } from "vitest";
import { buildRankPrompt, parseRankResponse } from "../extensions/ec-concierge/tools/rank.ts";
import { buildRecommendationMarkdown } from "../extensions/ec-concierge/tools/recommend.ts";
import { applyRequirements, emptyState, upsertCandidate } from "../extensions/ec-concierge/state.ts";

describe("parseRankResponse", () => {
	it("素のJSON配列を読む", () => {
		const entries = parseRankResponse('[{"id":"a","score":80,"reason":"予算内"},{"id":"b","score":95,"reason":"最適"}]');
		expect(entries.map((entry) => entry.id)).toEqual(["b", "a"]); // 降順に並ぶ
	});

	it("コードフェンスや前置きが付いていても読む", () => {
		const text = '評価しました。\n```json\n[{"id":"a","score":70,"reason":"可"}]\n```\n以上です。';
		expect(parseRankResponse(text)).toEqual([{ id: "a", score: 70, reason: "可" }]);
	});

	it("スコアを0〜100に丸め、文字列も受け付ける", () => {
		const entries = parseRankResponse('[{"id":"a","score":"88.6","reason":""},{"id":"b","score":150,"reason":""}]');
		expect(entries).toEqual([
			{ id: "b", score: 100, reason: "" },
			{ id: "a", score: 89, reason: "" },
		]);
	});

	it("idのない要素やJSONでない出力は無視する", () => {
		expect(parseRankResponse('[{"score":80}]')).toEqual([]);
		expect(parseRankResponse("すみません、評価できません")).toEqual([]);
		expect(parseRankResponse('[{"id":"a",]')).toEqual([]);
	});
});

describe("buildRankPrompt", () => {
	it("要件と候補、出力形式の指示を含める", () => {
		let state = applyRequirements(emptyState(), { goal: "花粉症対策", budgetMax: 50000, mustHave: ["静音"] });
		state = upsertCandidate(state, {
			url: "https://kakaku.com/item/K1/",
			title: "商品A",
			price: 39800,
			pros: ["静か"],
			cons: ["フィルターが高い"],
		});
		const prompt = buildRankPrompt(state, state.candidates, "静音性");
		expect(prompt).toContain("花粉症対策");
		expect(prompt).toContain("商品A");
		expect(prompt).toContain("39,800円");
		expect(prompt).toContain("静か");
		expect(prompt).toContain("特に重視する観点: 静音性");
		expect(prompt).toContain('"score"');
	});
});

describe("buildRecommendationMarkdown", () => {
	const state = applyRequirements(emptyState(), { goal: "花粉症対策", budgetMax: 50000 });
	const params = {
		summary: "静音性と維持費を重視して選びました。",
		items: [
			{
				rank: 2,
				title: "商品B",
				headline: "予算重視ならこれ",
				why: "予算内で最低条件を満たす",
				pros: ["安い"],
				cons: ["フィルター交換が半年ごと"],
				purchase_options: [{ shop: "楽天市場 テスト店", url: "https://item.rakuten.co.jp/b/", price: 29800 }],
			},
			{
				rank: 1,
				title: "商品A",
				headline: "総合的に一番",
				why: "静音性が高く、要件の予算内",
				price_note: "実売39,800円前後",
				pros: ["静か", "フィルター寿命が長い"],
				cons: ["本体が大きい"],
				purchase_options: [
					{ shop: "ヨドバシ.com", url: "https://www.yodobashi.com/product/a/", price: 39800, note: "ポイント10%" },
				],
				evidence: ["https://kakaku.com/review/1"],
			},
		],
		also_considered: ["商品C: 予算オーバーのため除外"],
		next_steps: ["設置場所の寸法を確認する"],
	};

	it("rank 順に並べ、要件・理由・価格・購入リンク・注意点を含む", () => {
		const markdown = buildRecommendationMarkdown(params, state, new Date("2026-08-24T10:00:00Z"));
		expect(markdown.indexOf("### 1. 商品A")).toBeLessThan(markdown.indexOf("### 2. 商品B"));
		expect(markdown).toContain("## 聞き取った要件");
		expect(markdown).toContain("花粉症対策");
		expect(markdown).toContain("おすすめの理由: 静音性が高く、要件の予算内");
		expect(markdown).toContain("[ヨドバシ.com](https://www.yodobashi.com/product/a/) — 39,800円（ポイント10%）");
		expect(markdown).toContain("- 注意点:");
		expect(markdown).toContain("本体が大きい");
		expect(markdown).toContain("https://kakaku.com/review/1");
		expect(markdown).toContain("## 検討したが外したもの");
		expect(markdown).toContain("## 次のステップ");
		expect(markdown).toContain("購入前に必ず販売ページで最新の情報を確認");
	});

	it("最小構成でも壊れない", () => {
		const markdown = buildRecommendationMarkdown(
			{
				summary: "結論",
				items: [
					{ rank: 1, title: "X", headline: "H", why: "W", pros: [], cons: [], purchase_options: [] },
				],
			},
			emptyState(),
		);
		expect(markdown).toContain("### 1. X");
		expect(markdown).toContain("(まだ何も聞き取れていません)");
	});
});
